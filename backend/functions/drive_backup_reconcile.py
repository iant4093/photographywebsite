"""Reconcile committed gallery state into an identified website Drive backup."""
import os
import posixpath
import tempfile
import uuid

from boto3.dynamodb.types import TypeDeserializer
from googleapiclient.http import MediaFileUpload

import drive_backup_jobs as jobs
import google_drive_sync as provider
from media_access import media_id_for_key, validate_album_media_key

MEDIA_ID = 'ianPhotographyMediaId'


def live_album(album_id):
    album = provider.table.get_item(Key={'albumId': album_id}, ConsistentRead=True).get('Item')
    return album if album and album.get('status', 'active') == 'active' else None


def assert_root(service, folder):
    root = os.environ['GOOGLE_DRIVE_FOLDER_ID']
    seen = set()
    current = folder
    for _ in range(12):
        if current.get('id') == root:
            return
        parents = current.get('parents', [])
        if len(parents) != 1 or parents[0] in seen:
            break
        seen.add(parents[0])
        current = service.files().get(fileId=parents[0], fields='id,parents,trashed', supportsAllDrives=True).execute()
        if current.get('trashed'):
            break
    raise RuntimeError('Backup folder is outside the configured root')


def album_folder(service, album):
    folder_id = album.get('driveFolderId')
    folder = service.files().get(fileId=folder_id, fields='id,name,mimeType,parents,appProperties,trashed', supportsAllDrives=True).execute() if folder_id else provider._album_folder_by_id(service, album['albumId'])
    if folder:
        if folder.get('trashed') or (folder.get('appProperties') or {}).get(provider.APP_ALBUM_ID_KEY) != album['albumId']:
            raise RuntimeError('Backup folder identity could not be verified')
        assert_root(service, folder)
    elif not album.get('backupToGoogleDrive'):
        raise RuntimeError('Existing backup folder is unavailable')
    type_id = provider.find_or_create_folder(service, 'Videos' if album.get('type') == 'video' else 'Photos', os.environ['GOOGLE_DRIVE_FOLDER_ID'])
    category_id = provider.find_or_create_folder(service, album.get('category') or 'Uncategorized', type_id, app_properties={provider.APP_KIND_KEY: 'category'})
    if folder:
        update = {'fileId': folder['id'], 'body': {'name': album['title']}, 'fields': 'id', 'supportsAllDrives': True}
        parents = folder.get('parents', [])
        if category_id not in parents:
            update.update(addParents=category_id, removeParents=','.join(parents))
        service.files().update(**update).execute()
        folder_id = folder['id']
    else:
        folder_id = provider.find_or_create_folder(service, album['title'], category_id, app_properties={provider.APP_KIND_KEY: 'album', provider.APP_ALBUM_ID_KEY: album['albumId']})
    provider.table.update_item(Key={'albumId': album['albumId']}, UpdateExpression='SET driveFolderId = :folder', ConditionExpression='attribute_exists(albumId)', ExpressionAttributeValues={':folder': folder_id})
    return folder_id


def children(service, folder_id):
    result = []
    token = None
    while True:
        params = {'q': f"'{provider._drive_literal(folder_id)}' in parents and trashed=false", 'fields': 'nextPageToken,files(id,name,appProperties,size,mimeType,md5Checksum)', 'pageSize': 1000, 'spaces': 'drive'}
        if token:
            params['pageToken'] = token
        page = service.files().list(**params).execute()
        result.extend(page.get('files', []))
        token = page.get('nextPageToken')
        if not token:
            return result


def current_keys(album):
    return {validate_album_media_key(item.get('rawKey') or item.get('key'), album=album) for item in album.get('images', []) if isinstance(item, dict)}


def upload(service, album, key, folder_id, context):
    head = provider.s3.head_object(Bucket=os.environ['IMAGES_BUCKET'], Key=key)
    # Match the gallery's 5 GiB video upload limit, with 1 GiB disk headroom.
    if int(head.get('ContentLength', 0)) > 5 * 1024 * 1024 * 1024:
        raise RuntimeError('Original exceeds Drive worker temporary storage')
    path = None
    try:
        with tempfile.NamedTemporaryFile(prefix='drive-', delete=False) as handle:
            path = handle.name
        provider.s3.download_file(os.environ['IMAGES_BUCKET'], key, path)
        latest = live_album(album['albumId'])
        if not latest or key not in current_keys(latest):
            return None
        request = service.files().create(
            body={'name': posixpath.basename(key), 'parents': [folder_id], 'appProperties': {provider.APP_ALBUM_ID_KEY: album['albumId'], MEDIA_ID: media_id_for_key(key)}},
            media_body=MediaFileUpload(path, mimetype=head.get('ContentType', 'application/octet-stream'), chunksize=5 * 1024 * 1024, resumable=True), fields='id',
        )
        result = None
        while result is None:
            if context and context.get_remaining_time_in_millis() < 20000:
                raise RuntimeError('Backup needs another processing attempt')
            _, result = request.next_chunk(num_retries=3)
        return result['id']
    finally:
        if path and os.path.exists(path):
            os.remove(path)


def reconcile(job, context=None):
    album = live_album(job['albumId'])
    if not album:
        return True
    if not jobs.eligible(album):
        raise RuntimeError('Album has no backup authorization')
    service = provider.get_drive_service()
    folder_id = album_folder(service, album)
    files = children(service, folder_id)
    managed = {}
    for item in files:
        properties = item.get('appProperties') or {}
        if properties.get(provider.APP_ALBUM_ID_KEY) != album['albumId'] or not properties.get(MEDIA_ID):
            continue
        media_id = properties[MEDIA_ID]
        managed.setdefault(media_id, []).append(item['id'])
    for key in sorted(current_keys(album)):
        if context and context.get_remaining_time_in_millis() < 60000:
            raise RuntimeError('Backup needs another processing attempt')
        latest = live_album(album['albumId'])
        if not latest:
            return True
        if key not in current_keys(latest):
            continue
        media_id = media_id_for_key(key)
        file_ids = managed.get(media_id, [])
        file_id = file_ids[0] if file_ids else None
        if not file_id:
            file_id = upload(service, latest, key, folder_id, context)
        if file_id:
            jobs.state_table().put_item(Item={'albumId': album['albumId'], 'entry': 'media#' + media_id, 'fileId': file_id, 'folderId': folder_id})
    # Never delete arbitrary extras or infer deletions from an empty/missing
    # album. Only an explicitly committed media removal can trash a tagged file.
    for key in job.get('removedKeys', []):
        latest = live_album(album['albumId'])
        if not latest:
            return True
        if key in current_keys(latest):
            continue
        key = validate_album_media_key(key, album=latest)
        media_id = media_id_for_key(key)
        for file_id in managed.get(media_id, []):
            service.files().update(fileId=file_id, body={'trashed': True}, fields='id', supportsAllDrives=True).execute()
    return False


def process(album_id, entry, context=None):
    table = jobs.state_table()
    job = table.get_item(Key={'albumId': album_id, 'entry': entry}, ConsistentRead=True).get('Item')
    if not job or job.get('status') == 'done':
        return
    state = table.get_item(Key={'albumId': album_id, 'entry': 'state'}, ConsistentRead=True).get('Item', {})
    if state.get('retained') or not live_album(album_id):
        jobs.complete(job, retained=True)
        return
    owner = uuid.uuid4().hex
    if not jobs.claim(album_id, owner):
        raise RuntimeError('Backup is busy')
    try:
        retained = reconcile(job, context)
        jobs.complete(job, retained=retained)
    except Exception:
        jobs.fail(job)
        raise
    finally:
        jobs.release(album_id, owner)


def handler(event, context=None):
    decoder = TypeDeserializer()
    for record in event.get('Records', []):
        if record.get('eventName') != 'INSERT':
            continue
        item = {key: decoder.deserialize(value) for key, value in record.get('dynamodb', {}).get('NewImage', {}).items()}
        if item.get('recordType') in {'job', 'delivery'}:
            process(item['albumId'], item.get('jobEntry', item['entry']), context)
    return {'status': 'processed'}
