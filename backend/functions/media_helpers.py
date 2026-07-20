import os
import logging
import urllib.parse
import uuid
import boto3
import exifread
from decimal import Decimal

# Initialize AWS clients lazily
s3 = None
mediaconvert = None
logger = logging.getLogger("photography_api.media")

def get_s3_client():
    global s3
    if not s3:
        s3 = boto3.client('s3')
    return s3

def get_mediaconvert_client():
    global mediaconvert
    if not mediaconvert:
        mediaconvert = boto3.client('mediaconvert', region_name=os.environ['AWS_REGION'])
        try:
            endpoints = mediaconvert.describe_endpoints(MaxResults=1)
            mediaconvert = boto3.client('mediaconvert',
                                     region_name=os.environ['AWS_REGION'],
                                     endpoint_url=endpoints['Endpoints'][0]['Url'])
        except Exception as error:
            logger.error("mediaconvert_endpoint_lookup_failed error_type=%s", type(error).__name__)
    return mediaconvert

def format_fraction(value):
    """
    Helper to cleanly format exifread Ratio objects or IfdTags containing Ratios.
    Produces things like '1/60s', 'f/2.8', or '1.4'.
    """
    # If the value is an IfdTag (has 'values' attribute), extract its first item
    if hasattr(value, 'values') and isinstance(value.values, list) and len(value.values) > 0:
        val = value.values[0]
        if hasattr(val, 'num') and hasattr(val, 'den'):
            if val.den == 0:
                return str(val.num)
            if val.num == 0:
                return "0"
            if val.num == 1:
                return f"1/{val.den}"
            if val.num % val.den == 0:
                return str(val.num // val.den)
            return str(round(val.num / val.den, 1))

    # Existing logic for direct ratio objects
    if hasattr(value, 'num') and hasattr(value, 'den'):
        if value.den == 0:
            return str(value.num)
        if value.num == 0:
            return "0"
            
        # For shutter speeds (exposure time), we usually want "1/x" or a whole number
        if value.num == 1:
            return f"1/{value.den}"
        
        # If it divides evenly
        if value.num % value.den == 0:
            return str(value.num // value.den)
            
        # Decimal fallback
        return str(round(value.num / value.den, 1))
    return str(value)

def extract_exif_data(bucket, key):
    """
    Downloads the first 64KB of an image from S3, extracts its EXIF data using exifread,
    formats it, and returns a dictionary.
    """
    import io
    s3_client = get_s3_client()
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key, Range='bytes=0-65535')
        file_stream = io.BytesIO(response['Body'].read())
        tags = exifread.process_file(file_stream, details=False)

        exif_info = {}
        if 'Image Model' in tags:
            exif_info['model'] = str(tags['Image Model'])
        if 'EXIF LensModel' in tags:
            exif_info['lens'] = str(tags['EXIF LensModel'])
        if 'EXIF FocalLength' in tags:
            focal_length_val = format_fraction(tags['EXIF FocalLength'])
            exif_info['focalLength'] = f"{focal_length_val}mm"
        if 'EXIF FNumber' in tags:
            exif_info['focalRatio'] = f"f/{format_fraction(tags['EXIF FNumber'])}"
        if 'EXIF ExposureTime' in tags:
            exif_info['shutterSpeed'] = f"{format_fraction(tags['EXIF ExposureTime'])}s"
        if 'EXIF ISOSpeedRatings' in tags:
            exif_info['iso'] = f"ISO {tags['EXIF ISOSpeedRatings']}"

        return exif_info
    except Exception as error:
        # Object names can contain personal information; never include them or
        # provider error text in production logs.
        logger.warning("exif_extraction_failed error_type=%s", type(error).__name__)
        return None

def start_mediaconvert_job(source_s3_url, destination_s3_prefix):
    """
    Submits an HLS transcoding job to AWS Elemental MediaConvert.
    """
    mc_client = get_mediaconvert_client()
    role_arn = os.environ['MEDIACONVERT_ROLE_ARN']

    job_settings = {
        "Inputs": [
            {
                "AudioSelectors": {
                    "Audio Selector 1": {
                        "DefaultSelection": "DEFAULT"
                    }
                },
                "VideoSelector": {},
                "TimecodeSource": "ZEROBASED",
                "FileInput": source_s3_url
            }
        ],
        "OutputGroups": [
            {
                "Name": "Apple HLS",
                "OutputGroupSettings": {
                    "Type": "HLS_GROUP_SETTINGS",
                    "HlsGroupSettings": {
                        "SegmentLength": 10,
                        "MinSegmentLength": 0,
                        "Destination": destination_s3_prefix
                    }
                },
                "Outputs": [
                    {
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "H_264",
                                "H264Settings": {
                                    "RateControlMode": "QVBR",
                                    "QvbrSettings": {
                                        "QvbrQualityLevel": 7
                                    },
                                    "MaxBitrate": 5000000,
                                    "CodecProfile": "HIGH"
                                }
                            }
                        },
                        "AudioDescriptions": [
                            {
                                "CodecSettings": {
                                    "Codec": "AAC",
                                    "AacSettings": {
                                        "Bitrate": 96000,
                                        "CodingMode": "CODING_MODE_2_0",
                                        "SampleRate": 48000
                                    }
                                }
                            }
                        ],
                        "NameModifier": "_1080p5m",
                        "ContainerSettings": {
                            "Container": "M3U8",
                            "M3u8Settings": {}
                        }
                    }
                ]
            }
        ],
        "TimecodeConfig": {
            "Source": "ZEROBASED"
        }
    }

    try:
        response = mc_client.create_job(
            Role=role_arn,
            Settings=job_settings,
            Queue="Default"
        )
        return response['Job']['Id']
    except Exception as error:
        logger.error("mediaconvert_job_failed error_type=%s", type(error).__name__)
        raise
