#!/usr/bin/env python3
"""Dry-run one generated comparison prefix; apply only an exact reviewed orphan."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'functions'))


def inspect(albums, comparisons, s3, bucket, album_id, media_id, now, held=False):
    import re
    import uuid
    uuid.UUID(album_id)
    if not re.fullmatch('[a-f0-9]{24}', media_id): raise ValueError('Invalid media ID')
    album = albums.get_item(Key={'albumId':album_id}, ConsistentRead=True).get('Item')
    record = comparisons.get_item(Key={'albumId':album_id,'mediaId':media_id}, ConsistentRead=True).get('Item', {})
    if int(record.get('leaseUntil', 0)) >= now: raise ValueError('Comparison worker is active')
    if album:
        if album.get('status', 'active') != 'active' or (not held and int(album.get('mediaLeaseUntil', 0)) >= now):
            raise ValueError('Album is busy; resume its saved operation instead')
        from media_access import media_id_for_key
        if any(media_id_for_key(image.get('rawKey') or image.get('key')) == media_id for image in album.get('images', []) if isinstance(image, dict) and (image.get('rawKey') or image.get('key'))):
            raise ValueError('Comparison still belongs to a live image')
    else:
        proof = albums.get_item(Key={'albumId':'__ALBUM_DELETION__'+album_id}, ConsistentRead=True).get('Item')
        if not proof: raise ValueError('Missing album without a deletion receipt needs manual investigation')
    prefix = f'before/{album_id}/{media_id}/'
    page = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=100)
    objects = page.get('Contents', [])
    if any(now-item['LastModified'].timestamp() < 360 for item in objects):
        raise ValueError('Recent generated output requires a worker-settle interval')
    if album:
        album = {key:value for key,value in album.items() if key not in {'mediaLeaseOwner','mediaLeaseUntil'}}
    state = {'album':album, 'comparison':record, 'objects':[(x['Key'],x.get('ETag'),str(x['LastModified'])) for x in objects]}
    snapshot = hashlib.sha256(json.dumps(state, sort_keys=True, default=str).encode()).hexdigest()
    return {'albumId':album_id,'mediaId':media_id,'snapshot':snapshot,'objectsThisPage':len(objects),'more':bool(page.get('IsTruncated'))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('albums-table','comparison-table','preview-bucket','album-id','media-id'): parser.add_argument('--'+name, required=True)
    parser.add_argument('--region', default='us-west-2'); parser.add_argument('--expected-snapshot'); parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    import boto3
    session = boto3.Session(region_name=args.region)
    albums = session.resource('dynamodb').Table(args.albums_table)
    comparisons = session.resource('dynamodb').Table(args.comparison_table)
    s3 = session.client('s3')
    result = inspect(albums, comparisons, s3, args.preview_bucket, args.album_id, args.media_id, int(time.time()))
    if args.apply:
        if not args.expected_snapshot or result['snapshot'] != args.expected_snapshot: raise ValueError('Generate and review a fresh dry-run plan')
        os.environ.update(AWS_DEFAULT_REGION=args.region, ORIGINAL_COMPARISON_TABLE=args.comparison_table, ORIGINAL_PREVIEW_BUCKET=args.preview_bucket)
        from comparison_cleanup import clean
        from media_mutation import album_lease
        album = albums.get_item(Key={'albumId':args.album_id}, ConsistentRead=True).get('Item')
        if album:
            with album_lease(albums, args.album_id):
                checked = inspect(albums, comparisons, s3, args.preview_bucket, args.album_id, args.media_id, int(time.time()), held=True)
                if checked['snapshot'] != args.expected_snapshot: raise ValueError('Reviewed orphan changed before cleanup')
                result['complete'] = clean(args.album_id, [args.media_id])
        else:
            checked = inspect(albums, comparisons, s3, args.preview_bucket, args.album_id, args.media_id, int(time.time()))
            if checked['snapshot'] != args.expected_snapshot: raise ValueError('Reviewed orphan changed before cleanup')
            # New comparison workers cannot publish without a live album lease.
            result['complete'] = clean(args.album_id, [args.media_id])
    result['applied'] = args.apply
    print(json.dumps({'event':'generated_comparison_cleanup','at':int(time.time()),'result':result}))


if __name__ == '__main__': main()
