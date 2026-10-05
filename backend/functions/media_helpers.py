import os
import logging
import urllib.parse
import uuid

from hls_ladder import hls_destination_prefix, hls_is_current, hls_master_playlist_key  # noqa: F401
from hls_ladder import SCRUB_FRAME_EDGE, SCRUB_FRAME_INTERVAL
import boto3
from botocore.config import Config
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
        mediaconvert = boto3.client('mediaconvert', region_name=os.environ['AWS_REGION'], config=Config(connect_timeout=3, read_timeout=8, retries={'total_max_attempts': 1}))
        try:
            endpoints = mediaconvert.describe_endpoints(MaxResults=1)
            mediaconvert = boto3.client('mediaconvert',
                                     region_name=os.environ['AWS_REGION'],
                                     endpoint_url=endpoints['Endpoints'][0]['Url'], config=Config(connect_timeout=3, read_timeout=8, retries={'total_max_attempts': 1}))
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

# (name modifier, long side, short side, peak bit/s, QVBR quality). Each
# rung is a box the source is fitted into without upscaling.
HLS_LADDER = (
    ("_2160p", 3840, 2160, 16_000_000, 8),
    ("_1440p", 2560, 1440, 10_000_000, 8),
    ("_1080p", 1920, 1080, 6_500_000, 8),
    ("_720p", 1280, 720, 3_500_000, 7),
    ("_540p", 960, 540, 1_800_000, 7),
    ("_360p", 640, 360, 800_000, 7),
)
HLS_SEGMENT_SECONDS = 6


def _fit(width, height, box_width, box_height):
    scale = min(box_width / width, box_height / height, 1)
    return (round(width * scale / 2) * 2, round(height * scale / 2) * 2)


def hls_ladder(width=None, height=None):
    """The rungs worth encoding for a source of this size.

    Boxes follow the source's orientation, so a portrait phone video's
    "1080p" rung is 1080 wide. A rung that would only repeat a larger rung's
    output (a small source fitted into several boxes) is dropped. Unknown
    sizes get the whole ladder.
    """
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        width = height = 0
    if width <= 0 or height <= 0:
        return [(name, long, short, bitrate, quality) for name, long, short, bitrate, quality in HLS_LADDER]
    portrait = height > width
    rungs, seen = [], set()
    # Smallest first, so an output keeps the smallest box (and bitrate cap)
    # that produces it: a 1080p source's top rung is "_1080p", not "_2160p".
    for name, long, short, bitrate, quality in reversed(HLS_LADDER):
        box = (short, long) if portrait else (long, short)
        size = _fit(width, height, *box)
        if size in seen:
            continue
        seen.add(size)
        rungs.append((name, *box, bitrate, quality))
    return rungs[::-1]


def _hls_output(name_modifier, width, height, max_bitrate, quality=7):
    return {
        "VideoDescription": {
            "Width": width,
            "Height": height,
            # Preserve aspect ratio without padding or enlarging small sources.
            "ScalingBehavior": "FIT_NO_UPSCALE",
            "CodecSettings": {
                "Codec": "H_264",
                "H264Settings": {
                    "RateControlMode": "QVBR",
                    "QvbrSettings": {"QvbrQualityLevel": quality},
                    "MaxBitrate": max_bitrate,
                    "CodecProfile": "HIGH",
                    "GopSizeUnits": "AUTO",
                },
            },
        },
        "AudioDescriptions": [
            {
                "CodecSettings": {
                    "Codec": "AAC",
                    "AacSettings": {
                        "Bitrate": 96000,
                        "CodingMode": "CODING_MODE_2_0",
                        "SampleRate": 48000,
                    },
                },
            },
        ],
        "NameModifier": name_modifier,
        "ContainerSettings": {"Container": "M3U8", "M3u8Settings": {}},
    }


def _frame_size(width, height):
    """Even frame dimensions with a long edge of SCRUB_FRAME_EDGE, or None."""
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    scale = min(1.0, SCRUB_FRAME_EDGE / max(width, height))
    even = lambda value: max(2, int(round(value * scale / 2)) * 2)
    return even(width), even(height)


def _frames_group(destination_s3_prefix, width, height):
    """Timeline preview frames: a small JPEG every SCRUB_FRAME_INTERVAL seconds."""
    video = {
        "CodecSettings": {
            "Codec": "FRAME_CAPTURE",
            "FrameCaptureSettings": {
                "FramerateNumerator": 1,
                "FramerateDenominator": SCRUB_FRAME_INTERVAL,
                # Six hours of frames; longer videos simply stop previewing.
                "MaxCaptures": 10800,
                "Quality": 70,
            },
        },
    }
    size = _frame_size(width, height)
    if size:
        video.update(Width=size[0], Height=size[1])
    else:
        video["Width"] = SCRUB_FRAME_EDGE
    return {
        "Name": "Timeline frames",
        "OutputGroupSettings": {
            "Type": "FILE_GROUP_SETTINGS",
            "FileGroupSettings": {"Destination": destination_s3_prefix},
        },
        "Outputs": [{"ContainerSettings": {"Container": "RAW"}, "VideoDescription": video}],
    }


def _job_input(source_s3_url):
    return {
        "AudioSelectors": {
            "Audio Selector 1": {
                "DefaultSelection": "DEFAULT"
            }
        },
        # Honour rotation metadata (phone footage).
        "VideoSelector": {"Rotate": "AUTO"},
        "TimecodeSource": "ZEROBASED",
        "FileInput": source_s3_url
    }


def _create_job(job_settings, request_token):
    try:
        response = get_mediaconvert_client().create_job(
            Role=os.environ['MEDIACONVERT_ROLE_ARN'],
            Settings=job_settings,
            Queue="Default",
            **({"ClientRequestToken": request_token, "UserMetadata": {"dispatchToken": request_token}} if request_token else {}),
        )
        return response['Job']['Id']
    except Exception as error:
        logger.error("mediaconvert_job_failed error_type=%s", type(error).__name__)
        raise


def start_frame_capture_job(source_s3_url, frames_s3_prefix, *, request_token=None, width=None, height=None):
    """Timeline preview frames alone, for a video whose stream already exists."""
    return _create_job({
        "Inputs": [_job_input(source_s3_url)],
        "OutputGroups": [_frames_group(frames_s3_prefix, width, height)],
        "TimecodeConfig": {"Source": "ZEROBASED"},
    }, request_token)


def start_mediaconvert_job(source_s3_url, destination_s3_prefix, *, request_token=None, width=None, height=None,
                           frames_s3_prefix=None):
    """
    Submit an adaptive HLS ladder up to 4K so players can match each viewer's
    screen and connection, and viewers can pick a quality.

    Every rendition is a single file addressed by byte ranges, so a video is
    about a dozen objects however long it runs. With ``frames_s3_prefix`` the
    same job also writes the timeline preview frames.
    """
    job_settings = {
        "Inputs": [_job_input(source_s3_url)],
        "OutputGroups": [
            {
                "Name": "Apple HLS",
                "OutputGroupSettings": {
                    "Type": "HLS_GROUP_SETTINGS",
                    "HlsGroupSettings": {
                        "SegmentLength": HLS_SEGMENT_SECONDS,
                        "MinSegmentLength": 0,
                        "SegmentControl": "SINGLE_FILE",
                        "Destination": destination_s3_prefix,
                        "OutputSelection": "MANIFESTS_AND_SEGMENTS",
                    }
                },
                "Outputs": [_hls_output(*rung) for rung in hls_ladder(width, height)],
            }
        ],
        "TimecodeConfig": {
            "Source": "ZEROBASED"
        }
    }
    if frames_s3_prefix:
        job_settings["OutputGroups"].append(_frames_group(frames_s3_prefix, width, height))
    return _create_job(job_settings, request_token)
