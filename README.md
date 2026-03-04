# Ian Truong Photography Portfolio & Client Portal

My photography website! Includes a public portfolio and a private client portal for securely delivering high-resolution images and videos to clients. Built with React and Vite, the platform runs on a serverless AWS backend.

## High-Level Features

* **Public Portfolio Gallery:** A responsive grid layout to display my photography work.
* **Private Client Portals & Shared Albums:** Secure delivery of galleries to clients using unique share codes or accounts and email notifications.
* **Admin Dashboard:** A custom administration zone to manage albums, users, and permissions. Allows for direct media uploads to S3.
* **Smart Media Processing:** Automatic extraction of camera EXIF data for photos (lens, focal ratio, shutter speed, ISO).
* **Video Capability:** Automated processing and transcoding of uploaded video content into streamable HLS formats using AWS MediaConvert.
* **Google Drive Sync:** Automated backups of uploads to Google Drive.

## Tech Stack Overview

### Frontend
* **Framework:** React + Vite
* **Styling:** Tailwind CSS 
* **Routing:** React Router v6
* **State Management:** React Context API

### Backend & Infrastructure (AWS)
The backend runs on AWS resources, organized and defined as Infrastructure as Code using the AWS SAM.

* **Amazon S3:** Serves as the origin for the compiled React frontend static files and the high-resolution photography/video assets.
* **Amazon CloudFront:** A global CDN caching images at edge locations for gallery load times. Secures the custom domain with an ACM SSL/TLS certificate.
* **Amazon API Gateway:** Exposes the RESTful HTTP API endpoints for the frontend to communicate with the AWS Lambda functions.
* **AWS Lambda (Python 3.12):** Executes the core business logic (creating albums, extracting EXIF data, fetching metadata, generating presigned upload URLs, and managing users).
* **Amazon DynamoDB:** A NoSQL database used to store album metadata, share codes, visibility settings, and application rate limits.
* **Amazon Cognito:** Manages user authentication, signups, and access control. Issues RS256-signed JWTs for the admin dashboard and private client APIs.
* **AWS Elemental MediaConvert:** Automatically transcodes uploaded videos into streamable HLS playlists for the frontend to consume.
* **Resend:** Handles outgoing email notifications to clients when their albums are ready.
* **Amazon Route 53:** Manages DNS routing connecting the custom apex domain to the CloudFront distribution.

## Security Posture

Security measures in place for handling private client data:
* **Zero Hardcoded Secrets:** No API keys or sensitive credentials exist in the source code; they are injected dynamically during deployment using AWS SAM parameters.
* **Robust Auth & Access Control:** Every private API endpoint verifies AWS Cognito JWTs to ensure only authorized users (or the admin) can read or modify data.
* **Rate Limiting & Abuse Prevention:** Custom DynamoDB-backed rate limiters are deployed across sensitive endpoints (like Login, Contact, and Shared link fetching) to prevent spam and brute-force attacks.
* **Bot Protection:** Cloudflare Turnstile CAPTCHA intercepts automated bots trying to abuse the contact form or login pages.
* **Input Sanitization:** User-submitted text from form inputs is sanitized and escaped to prevent injection attacks.

---

## Project Structure

```text
├── src/
│   ├── components/      # Reusable React UI components (Navigation, Cards, Lightbox)
│   ├── context/         # React Context providers (Auth session management)
│   ├── pages/           # High level route components (Home, AlbumGallery, Dashboards)
│   └── utils/           # API fetch wrappers and helper modules
├── backend/
│   ├── functions/       # Python AWS Lambda functions (create_album, login, contact, mediaconvert logic, etc.)
│   └── template.yaml    # AWS SAM Infrastructure-as-Code template defining all AWS resources
├── index.html           # Vite HTML entry point
├── package.json         # Node.js dependencies and scripts
├── tailwind.config.js   # Tailwind CSS theme configuration (custom colors, fonts)
└── vite.config.js       # Vite bundler configuration
```
