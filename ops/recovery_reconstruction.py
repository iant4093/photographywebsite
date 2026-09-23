#!/usr/bin/env python3
"""Offline restore filter: suppress erased galleries/accounts; never activate work."""
import argparse
import json
import hashlib
from copy import deepcopy


def reconstruct(backup, current_records):
    erased_albums = set()
    erased_subjects = set()
    erased_media = {}
    for row in current_records:
        key = row.get('albumId', '')
        if key.startswith('__MEDIA_DELETION__'):
            value = row['payload']
            erased_media.setdefault(value['albumId'], set()).update(value['mediaIds'])
        if key.startswith('__ALBUM_DELETION__'):
            erased_albums.add(row['payload']['albumId'])
        if key.startswith('__USER_DELETION__') and row.get('deletionId'):
            subject = row.get('payload', {}).get('subject')
            if not subject: raise ValueError('Unresolved deletion fence requires manual review')
            erased_subjects.add(subject)
        if row.get('status') == 'deleting': erased_albums.add(key)
    restored, quarantined = [], []
    for row in backup:
        key = row.get('albumId', '')
        if key in erased_albums or row.get('ownerSub') in erased_subjects:
            continue
        # Email-only owners cannot be safely matched to removed identities.
        # Internal receipts and interrupted work are never auto-reactivated.
        if key.startswith('__') or row.get('ownerEmail') and not row.get('ownerSub') or row.get('status', 'active') != 'active' or any(k.startswith('pending') for k in row):
            quarantined.append(row)
            continue
        candidate = deepcopy(row)
        suppressed = erased_media.get(key, set())
        images = candidate.get('images', [])
        if not isinstance(images, list) or any(not isinstance(image, dict) or not (image.get('rawKey') or image.get('key')) for image in images):
            quarantined.append(row)
            continue
        candidate['images'] = [image for image in images if hashlib.sha256((image.get('rawKey') or image['key']).encode()).hexdigest()[:24] not in suppressed]
        candidate['imageCount'] = len(candidate['images'])
        candidate['visibility'] = 'private'
        candidate['isShared'] = False
        for field in ('coverImageUrl','coverThumbKey','coverBlurhash','mediaStoreVersion','sharedCode','shareCode'):
            candidate.pop(field, None)
        restored.append(candidate)
    return {'candidates':restored, 'quarantine':quarantined,
            'suppressedCount':len(backup)-len(restored)-len(quarantined)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup_json'); parser.add_argument('current_receipts_json'); parser.add_argument('output_json')
    args = parser.parse_args()
    with open(args.backup_json) as handle: backup = json.load(handle)
    with open(args.current_receipts_json) as handle: current = json.load(handle)
    result = reconstruct(backup, current)
    # Exclusive creation avoids overwriting original recovery evidence.
    with open(args.output_json, 'x') as handle: json.dump(result, handle, indent=2)


if __name__ == '__main__': main()
