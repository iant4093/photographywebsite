#!/usr/bin/env python3
"""Read bounded aggregate route, cold/warm-handler and preview-readiness timings."""
import argparse,datetime as dt,json,time

QUERIES={
    'routes': ('ApiAccessLogGroup', 'filter ispresent(responseLatency) and responseLatency != "-" | stats count(*) as requests, pct(responseLatency, 50) as responseP50Ms, pct(responseLatency, 95) as responseP95Ms, pct(integrationLatency, 95) as integrationP95Ms by routeKey, status | sort requests desc'),
    'handlers': ('ApplicationLogGroup', 'fields jsonParse(message) as payload | filter payload.event = "backend_performance" | stats count(*) as invocations, pct(payload.elapsedMs, 50) as p50Ms, pct(payload.elapsedMs, 95) as p95Ms, pct(payload.stagesMs.front_door, 95) as frontDoorP95Ms, pct(payload.stagesMs.catalog_read, 95) as catalogReadP95Ms, pct(payload.stagesMs.summary_join, 95) as summaryJoinP95Ms by payload.operation, payload.coldStart, payload.statusCode, payload.returned'),
    'previewReadiness': ('ApplicationLogGroup', 'fields jsonParse(message) as payload | fields coalesce(event, payload.event) as eventName, coalesce(status, payload.status) as jobStatus, coalesce(queueWaitMs, payload.queueWaitMs) as waitMs, coalesce(processingMs, payload.processingMs) as processMs, coalesce(queuedToCompleteMs, payload.queuedToCompleteMs) as readyMs | filter eventName = "preview_job_completed" and jobStatus = "completed" and ispresent(readyMs) | stats count(*) as jobs, pct(waitMs, 95) as queueWaitP95Ms, pct(processMs, 95) as processingP95Ms, pct(readyMs, 50) as queuedToCompleteP50Ms, pct(readyMs, 95) as queuedToCompleteP95Ms'),
}


def window(hours, now=None):
    if type(hours) is not int or not 1 <= hours <= 168:
        raise ValueError('Report window must be between one and 168 hours')
    now=now or dt.datetime.now(dt.timezone.utc)
    return now-dt.timedelta(hours=hours),now


def wait_result(logs,query_id,timeout=60):
    deadline=time.monotonic()+timeout
    while True:
        result=logs.get_query_results(queryId=query_id)
        if result['status']=='Complete':
            rows=[{field['field']:field['value'] for field in row} for row in result['results']]
            samples=any(float(row.get(key, 0)) > 0 for row in rows for key in ('requests','invocations','jobs'))
            return {'rows':rows, 'bytesScanned':result.get('statistics',{}).get('bytesScanned'), 'noSamples':not samples}
        if result['status'] not in {'Scheduled','Running'}:
            raise ValueError('Aggregate performance query did not complete')
        if time.monotonic()>=deadline:
            logs.stop_query(queryId=query_id)
            raise TimeoutError('Aggregate performance query exceeded the bounded wait')
        time.sleep(1)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-account-id',required=True)
    parser.add_argument('--hours',type=int,default=24)
    args=parser.parse_args(argv);first,last=window(args.hours)
    import boto3
    cf=boto3.client('cloudformation',region_name='us-west-2');stack=cf.describe_stacks(StackName='ian-website')['Stacks'][0]
    if stack['StackId'].split(':')[4]!=args.expected_account_id:
        raise ValueError('Application stack belongs to a different AWS account')
    resources={r['LogicalResourceId']:r for page in cf.get_paginator('list_stack_resources').paginate(StackName='ian-website') for r in page['StackResourceSummaries']}
    logs=boto3.client('logs',region_name='us-west-2');pending={}
    for label,(resource,query) in QUERIES.items():
        pending[label]=logs.start_query(logGroupName=resources[resource]['PhysicalResourceId'],startTime=int(first.timestamp()),endTime=int(last.timestamp()),queryString=query,limit=500)['queryId']
    report={'startUtc':first.isoformat(),'endUtc':last.isoformat(),'reports':{label:wait_result(logs,q) for label,q in pending.items()},'limits':['Handler elapsed time excludes managed-runtime initialization; coldStart marks the first handler invocation.','Preview readiness starts at SQS send time and ends at processing completion, not browser rendering.','No samples means unavailable, not zero latency. Percentiles from separate reports must not be averaged.']}
    print(json.dumps(report))


if __name__=='__main__':main()
