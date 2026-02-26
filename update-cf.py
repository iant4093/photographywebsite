import json

with open('cf-config.json', 'r') as f:
    config = json.load(f)

config['Aliases'] = {
    'Quantity': 1,
    'Items': ['iantruongphotography.com']
}
config['ViewerCertificate'] = {
    'CloudFrontDefaultCertificate': False,
    'ACMCertificateArn': 'arn:aws:acm:us-east-1:428207759706:certificate/60e0dd6b-9a68-4a5c-a2f2-033e938ba836',
    'SSLSupportMethod': 'sni-only',
    'MinimumProtocolVersion': 'TLSv1.2_2021',
    'Certificate': 'arn:aws:acm:us-east-1:428207759706:certificate/60e0dd6b-9a68-4a5c-a2f2-033e938ba836',
    'CertificateSource': 'acm'
}

with open('cf-config-updated.json', 'w') as f:
    json.dump(config, f)
