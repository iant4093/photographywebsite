import os
import json
import boto3
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

s3 = boto3.client('s3')

def get_drive_service():
    """Authenticates and returns the Google Drive API service."""
    try:
        # Load OAuth token directly from the file bundled with the Lambda.
        token_file = "google_oauth_token.json"
        
        # In a Lambda environment, the working directory contains the function deployment package
        # but it might be read-only, so we just read from it.
        if not os.path.exists(token_file):
            raise Exception(f"{token_file} file not found in deployment package.")
            
        from google.oauth2.credentials import Credentials
        credentials = Credentials.from_authorized_user_file(
            token_file,
            scopes=['https://www.googleapis.com/auth/drive.file']
        )
        service = build('drive', 'v3', credentials=credentials)
        return service
    except Exception as e:
        print(f"Error authenticating with Google Drive: {e}")
        raise

def find_or_create_folder(service, folder_name, parent_id=None):
    """Finds a folder by name or creates it if it doesn't exist."""
    query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and trashed=false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
        
    results = service.files().list(
        q=query, spaces='drive', fields="files(id, name)"
    ).execute()
    
    items = results.get('files', [])
    if items:
        # Folder exists
        return items[0].get('id')
    else:
        # Create folder
        file_metadata = {
            'name': folder_name,
            'mimeType': 'application/vnd.google-apps.folder'
        }
        if parent_id:
            file_metadata['parents'] = [parent_id]
            
        folder = service.files().create(
            body=file_metadata, fields='id'
        ).execute()
        return folder.get('id')

def handler(event, context):
    """
    Asynchronous handler to stream files from S3 to Google Drive.
    Expected event payload:
    {
        "albumType": "photo" | "video",
        "albumTitle": "Album Name",
        "bucket": "s3-bucket-name",
        "keys": ["s3/key1.jpg", "s3/key2.mp4", ...]
    }
    """
    print(f"Received event: {json.dumps(event)}")
    
    root_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
    if not root_folder_id:
        print("GOOGLE_DRIVE_FOLDER_ID environment variable is missing.")
        return {"status": "error", "message": "Missing GOOGLE_DRIVE_FOLDER_ID"}
        
    album_type = event.get('albumType', 'photo')
    album_title = event.get('albumTitle', 'Unnamed Album')
    bucket = event.get('bucket')
    keys = event.get('keys', [])
    
    if not bucket or not keys:
        print("Missing bucket or keys in payload.")
        return {"status": "error", "message": "Missing bucket or keys"}

    try:
        service = get_drive_service()
        
        # 1. Ensure type-specific subfolder exists (Photos or Videos) under the root folder
        type_folder_name = "Photos" if album_type == 'photo' else "Videos"
        type_folder_id = find_or_create_folder(service, type_folder_name, root_folder_id)
        
        # 2. Ensure Album folder exists under the type folder
        album_folder_id = find_or_create_folder(service, album_title, type_folder_id)
        
        uploaded_files = []
        for key in keys:
            print(f"Uploading {key} to Google Drive...")
            try:
                # Download to /tmp first since googleapiclient requires a seekable file object for chunks
                filename = key.split('/')[-1]
                tmp_path = f"/tmp/{filename}"
                
                # Get file metadata to log size
                head = s3.head_object(Bucket=bucket, Key=key)
                content_type = head['ContentType']
                file_size = head['ContentLength']
                
                print(f"Downloading {key} to {tmp_path} size {file_size}...")
                s3.download_file(bucket, key, tmp_path)
                
                # Setup MediaFileUpload for Drive
                from googleapiclient.http import MediaFileUpload
                media = MediaFileUpload(tmp_path, mimetype=content_type, chunksize=1024*1024*5, resumable=True)
                
                file_metadata = {
                    'name': filename,
                    'parents': [album_folder_id]
                }
                
                request = service.files().create(body=file_metadata, media_body=media, fields='id')
                
                response = None
                while response is None:
                    status, response = request.next_chunk()
                    if status:
                        print(f"Uploaded {int(status.progress() * 100)}%")
                        
                print(f"Upload complete for {filename}. Drive ID: {response.get('id')}")
                uploaded_files.append(filename)
                
                # Clean up temp file
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                    
            except Exception as e:
                print(f"Error uploading file {key}: {e}")
                if 'tmp_path' in locals() and os.path.exists(tmp_path):
                    os.remove(tmp_path)
                
        return {"status": "success", "uploaded": uploaded_files}

    except Exception as e:
        print(f"Fatal error in Drive sync: {e}")
        return {"status": "error", "message": str(e)}
