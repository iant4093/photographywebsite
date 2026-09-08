#!/usr/bin/env python3
"""Inventory/link existing website backups; never upload, move, or trash media.

Print aggregate counts and a plan digest only. Existing folders without a live
album are archives and remain untouched. Ambiguous live identities fail closed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

import boto3


def inventory(table, service, root):
    albums = []
    cursor = None
    while True:
        page = table.scan(**({'ExclusiveStartKey': cursor} if cursor else {}))
        albums.extend(item for item in page.get('Items', []) if item.get('status', 'active') == 'active')
        cursor = page.get('LastEvaluatedKey')
        if not cursor:
            break
    by_id = {album['albumId']: album for album in albums}
    from drive_backup_reconcile import children, MEDIA_ID
    from media_access import media_id_for_key
    from google_drive_sync import APP_ALBUM_ID_KEY, APP_KIND_KEY, FOLDER_MIME_TYPE
    folders = []
    for type_folder in children(service, root):
        if type_folder.get('mimeType') != FOLDER_MIME_TYPE or type_folder['name'] not in {'Photos', 'Videos'}:
            continue
        kind = 'photo' if type_folder['name'] == 'Photos' else 'video'
        for child in children(service, type_folder['id']):
            if child.get('mimeType') != FOLDER_MIME_TYPE:
                continue
            if (child.get('appProperties') or {}).get(APP_KIND_KEY) == 'category':
                folders.extend((kind, item) for item in children(service, child['id']) if item.get('mimeType') == FOLDER_MIME_TYPE)
            else:
                folders.append((kind, child))
    links = []
    archives = 0
    seen = set()
    for kind, folder in folders:
        tagged = (folder.get('appProperties') or {}).get(APP_ALBUM_ID_KEY)
        if tagged:
            album = by_id.get(tagged)
        else:
            candidates = [album for album in albums if album.get('type', 'photo') == kind and album['title'] == folder['name']]
            if len(candidates) > 1:
                raise RuntimeError('Ambiguous legacy album folder')
            album = candidates[0] if candidates else None
        if not album:
            archives += 1
            continue
        if album['albumId'] in seen or album.get('type', 'photo') != kind:
            raise RuntimeError('Duplicate or conflicting backup identity')
        seen.add(album['albumId'])
        files = children(service, folder['id'])
        by_name = {}
        for file in files:
            by_name.setdefault(file['name'], []).append(file)
        keys = sorted(set(item.get('rawKey') or item.get('key') for item in album.get('images', []) if isinstance(item, dict)))
        basenames = Counter(key.rsplit('/', 1)[-1] for key in keys if key)
        media = []
        for key in keys:
            if not key:
                continue
            name = key.rsplit('/', 1)[-1]
            media_id = media_id_for_key(key)
            tagged_matches = [file for file in files if (file.get('appProperties') or {}).get(APP_ALBUM_ID_KEY) == album['albumId'] and (file.get('appProperties') or {}).get(MEDIA_ID) == media_id]
            matches = tagged_matches or by_name.get(name, [])
            if matches and basenames[name] > 1:
                raise RuntimeError('Ambiguous legacy backup file')
            if len(matches) > 1 and not tagged_matches:
                # Old upload retries sometimes left duplicate copies. Link all
                # byte-identical originals, preserving differing/manual extras.
                s3 = boto3.client('s3')
                head = s3.head_object(Bucket=os.environ['IMAGES_BUCKET'], Key=key)
                checksum = head.get('ETag', '').strip('\"')
                if '-' in checksum or not checksum:
                    response = s3.get_object(Bucket=os.environ['IMAGES_BUCKET'], Key=key)
                    digest = hashlib.md5()
                    with response['Body'] as stream:
                        for chunk in stream.iter_chunks(chunk_size=1024 * 1024): digest.update(chunk)
                    checksum = digest.hexdigest()
                matches = [file for file in matches if file.get('md5Checksum') == checksum and int(file.get('size', -1)) == head['ContentLength']]
                if not matches:
                    raise RuntimeError('Legacy backup content could not be matched')
            for match in matches:
                props = match.get('appProperties') or {}
                if props.get(APP_ALBUM_ID_KEY) not in {None, album['albumId']} or props.get(MEDIA_ID) not in {None, media_id}:
                    raise RuntimeError('Conflicting backup file identity')
                media.append({'fileId': match['id'], 'mediaId': media_id, 'tagged': bool(tagged_matches)})
        links.append({'albumId': album['albumId'], 'folderId': folder['id'], 'folderTagged': tagged == album['albumId'], 'linked': album.get('driveFolderId') == folder['id'], 'media': sorted(media, key=lambda item: item['fileId'])})
    links.sort(key=lambda item: item['albumId'])
    digest = hashlib.sha256(json.dumps(links, sort_keys=True).encode()).hexdigest()
    return links, {'albumCount': len(albums), 'linkedBackupCount': len(links), 'retainedArchiveCount': archives,
                   'filesMatched': sum(len(link['media']) for link in links),
                   'albumsToLink': sum(not link['linked'] for link in links),
                   'filesToTag': sum(not file['tagged'] for link in links for file in link['media']), 'planDigest': digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--table', required=True)
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--credential-parameter', required=True)
    parser.add_argument('--expected-account', required=True)
    parser.add_argument('--region', default='us-west-2')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-digest')
    args = parser.parse_args()
    if boto3.client('sts', region_name=args.region).get_caller_identity()['Account'] != args.expected_account:
        raise RuntimeError('AWS account guard failed')
    os.environ.update(ALBUMS_TABLE=args.table, IMAGES_BUCKET=args.bucket, GOOGLE_DRIVE_FOLDER_ID=args.root,
                      GOOGLE_OAUTH_PARAMETER=args.credential_parameter, AWS_DEFAULT_REGION=args.region)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'functions'))
    import google_drive_sync as provider
    from drive_backup_reconcile import MEDIA_ID
    service = provider.get_drive_service()
    links, summary = inventory(provider.table, service, args.root)
    if args.apply:
        if not args.expected_digest or summary['planDigest'] != args.expected_digest:
            raise RuntimeError('Inventory changed; review a fresh plan')
        local = threading.local()
        def apply_link(link):
            if not hasattr(local, 'service'):
                local.service = provider.get_drive_service()
            drive = local.service
            if not link['folderTagged']:
                drive.files().update(fileId=link['folderId'], body={'appProperties': {provider.APP_ALBUM_ID_KEY: link['albumId'], provider.APP_KIND_KEY: 'album'}}, fields='id').execute(num_retries=3)
            for file in link['media']:
                if not file['tagged']:
                    drive.files().update(fileId=file['fileId'], body={'appProperties': {provider.APP_ALBUM_ID_KEY: link['albumId'], MEDIA_ID: file['mediaId']}}, fields='id').execute(num_retries=3)
            if not link['linked']:
                boto3.resource('dynamodb').Table(args.table).update_item(Key={'albumId': link['albumId']}, UpdateExpression='SET driveFolderId = :id',
                                           ConditionExpression='attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)',
                                           ExpressionAttributeNames={'#status': 'status'}, ExpressionAttributeValues={':id': link['folderId'], ':active': 'active'})
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(apply_link, links))
    print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', **summary}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'errorType': type(error).__name__, 'status': 'inventory_failed'}))
        raise SystemExit(1) from None
