# Ian Truong Photography Portfolio & Client Portal

My photgraphy website! Includes a public portfolio and a private client portal for sharing images. Built with React, Vite, and deployed on AWS. 

## Tech Stack Overview

### Frontend
* **Framework:** React + Vite
* **Styling:** Tailwind CSS
* **Routing:** React Router v6
* **State Management:** React Context API

### Backend & Infrastructure (AWS)
The entire backend runs on AWS resources, organized and defined as Infrastructure as Code using the AWS SAM.

* **Amazon S3:** Serves as the origin for both the compiled React frontend static files and the high resolution photography assets.
* **Amazon CloudFront:** A global CDN that caches images at edge locations worldwide to ensure fast gallery load times. It also secures the `iantruongphotography.com` custom domain with an ACM SSL/TLS certificate.
* **Amazon API Gateway:** Exposes the RESTful HTTP API endpoints between the React frontend and the backend Lambda functions.
* **AWS Lambda (Python 3.12):** Executes the core business logic (creating albums, fetching gallery metadata, generating presigned S3 upload URLs, and managing users) without provisioning or managing servers.
* **Amazon DynamoDB:** NoSQL database used to store album metadata (titles, descriptions, visibility settings, client assignments, S3 prefixes).
* **Amazon Cognito:** Manages user authentication, signups, and access control. Generates RS256-signed JWT for secure session management and role based access to the admin dashboard and private client APIs.
* **Amazon SES (Simple Email Service):** Outgoing email notifications. ("Your new album is ready!").
* **Amazon Route 53:** Manages DNS routing connecting the custom apex domain to the CloudFront distribution and verifying SES email identities.

---

## Project Structure

```text
├── src/
│   ├── components/      # Reusable React UI components (Navigation, Cards, Lightbox)
│   ├── context/         # React Context providers (Auth session management)
│   ├── pages/           # High level route components (Home, AlbumGallery, Dashboards)
│   └── utils/           # API fetch wrappers and helper modules
├── backend/
│   ├── functions/       # Python AWS Lambda function source code
│   └── template.yaml    # AWS SAM Infrastructure-as-Code template
├── index.html           # Vite HTML entry point
├── package.json         # Node.js dependencies and scripts
├── tailwind.config.js   # Tailwind CSS theme configuration (custom colors, fonts)
└── vite.config.js       # Vite bundler configuration
```

---

## Getting Started - Local Dev

### Prerequisites
* Node.js (v18+)
* Python (3.12+)
* AWS CLI (configured with administrator credentials)
* AWS SAM CLI

### 1. Local Frontend Development
Navigate to the project root and install JavaScript dependencies:
```bash
npm install
npm run dev
```
The React development server will start on `http://localhost:5173`.

### 2. Backend Deployment
Navigate to the `backend/` directory to build and deploy the AWS Serverless infrastructure:
```bash
cd backend
sam build
sam deploy --guided
```
Follow the interactive prompts to define the Stack Name, AWS Region, and application parameters. SAM will automatically deploy the API Gateway, S3 Buckets, DynamoDB Tables, Cognito User Pool, and Lambda functions.

### 3. Frontend Deployment
After the backend stack is deployed, update your `.env` file with the newly generated API endpoint and Cognito IDs. Then build and sync the frontend to S3:
```bash
npm run build
aws s3 sync dist/ s3://<your-s3-bucket-name> --delete
aws cloudfront create-invalidation --distribution-id <your-distribution-id> --paths "/*"
```
