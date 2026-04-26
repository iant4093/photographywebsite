import json
import os
import io
import time
import zipfile
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

class StreamToS3(io.RawIOBase):
    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.multipart = s3.create_multipart_upload(Bucket=bucket, Key=key)
        self.parts = []
        self.buffer = bytearray()
        self.part_number = 1
        self.part_size = 5 * 1024 * 1024
        self._is_closed = False

    def write(self, b):
        self.buffer.extend(b)
        while len(self.buffer) >= self.part_size:
            self._upload_part(self.buffer[:self.part_size])
            del self.buffer[:self.part_size]
        return len(b)

    def _upload_part(self, data):
        response = s3.upload_part(
            Bucket=self.bucket,
            Key=self.key,
            UploadId=self.multipart['UploadId'],
            PartNumber=self.part_number,
            Body=bytes(data)
        )
        self.parts.append({'PartNumber': self.part_number, 'ETag': response['ETag']})
        self.part_number += 1

    def close(self):
        if self._is_closed: return
        self._is_closed = True
        if self.buffer:
            self._upload_part(self.buffer)
            self.buffer.clear()
        s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=self.key,
            UploadId=self.multipart['UploadId'],
            MultipartUpload={'Parts': self.parts}
        )
        super().close()

    def cancel(self):
        s3.abort_multipart_upload(
            Bucket=self.bucket, Key=self.key, UploadId=self.multipart['UploadId']
        )

def get_album_record(album_id=None, share_code=None):
    if not os.environ.get('ALBUMS_TABLE'): return None
    table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
    if album_id:
        return table.get_item(Key={'albumId': album_id}).get('Item')
    if share_code:
        resp = table.query(
            IndexName='ShareCodeIndex',
            KeyConditionExpression=boto3.dynamodb.conditions.Key('shareCode').eq(share_code)
        )
        items = resp.get('Items', [])
        return items[0] if items else None
    return None

def handler(event, context):
    try:
        # Worker receives payload directly from create_zip.py invocation
        album_id = event.get('albumId')
        share_code = event.get('shareCode')
        
        if not album_id and not share_code:
            print("Missing identifier in worker event")
            return
            
        album = get_album_record(album_id=album_id, share_code=share_code)
        if not album:
            print(f"Album not found for id {album_id} / shareCode {share_code}")
            return

        bucket = os.environ.get('IMAGES_BUCKET')
        images = album.get('images', [])

        zip_filename = f"album_{album.get('albumId')}.zip"
        zip_key = f"temp-zips/{zip_filename}"
        lock_key = f"temp-zips/album_{album.get('albumId')}.lock"

        print(f"Worker generating ZIP for {len(images)} images to {zip_key}")
        s3_stream = StreamToS3(bucket, zip_key)
        
        try:
            with zipfile.ZipFile(s3_stream, 'w', compression=zipfile.ZIP_STORED) as zip_file:
                for img in images:
                    if album.get('type') == 'video': continue
                    raw_key = img.get('rawKey')
                    if not raw_key: continue
                    
                    file_name = raw_key.split('/')[-1]
                    resp = s3.get_object(Bucket=bucket, Key=raw_key)
                    
                    with zip_file.open(file_name, 'w') as zinfo:
                        for chunk in iter(lambda: resp['Body'].read(1024 * 1024), b''):
                            zinfo.write(chunk)
        except Exception as zip_err:
            print(f"Zip execution failed: {zip_err}")
            s3_stream.cancel()
            # Clean up lock so the user can retry
            try:
                s3.delete_object(Bucket=bucket, Key=lock_key)
                print(f"Cleaned up lock after failure: {lock_key}")
            except Exception:
                pass
            return
            
        s3_stream.close()
        print(f"Worker finished generating {zip_key}")

        # Clean up lock marker — the ZIP is now available
        try:
            s3.delete_object(Bucket=bucket, Key=lock_key)
            print(f"Cleaned up lock: {lock_key}")
        except Exception:
            pass

    except Exception as e:
        print(f"Worker fatal error: {e}")

