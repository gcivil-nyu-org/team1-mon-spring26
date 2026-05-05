import boto3
from django.core.management.base import BaseCommand
from django.conf import settings

class Command(BaseCommand):
    help = 'Creates the DynamoDB table if it does not exist'

    def handle(self, *args, **options):
        table_name = settings.DYNAMODB_TABLE_NAME
        region = settings.DYNAMODB_REGION
        endpoint_url = getattr(settings, 'DYNAMODB_ENDPOINT_URL', None)

        kwargs = {'region_name': region}
        if endpoint_url:
            kwargs['endpoint_url'] = endpoint_url

        dynamodb = boto3.resource('dynamodb', **kwargs)
        client = boto3.client('dynamodb', **kwargs)

        try:
            client.describe_table(TableName=table_name)
            self.stdout.write(self.style.SUCCESS(f"Table '{table_name}' already exists. Skipping creation."))
        except client.exceptions.ResourceNotFoundException:
            self.stdout.write(f"Creating DynamoDB table '{table_name}'...")
            table = dynamodb.create_table(
                TableName=table_name,
                KeySchema=[
                    {'AttributeName': 'PK', 'KeyType': 'HASH'},
                    {'AttributeName': 'SK', 'KeyType': 'RANGE'}
                ],
                AttributeDefinitions=[
                    {'AttributeName': 'PK', 'AttributeType': 'S'},
                    {'AttributeName': 'SK', 'AttributeType': 'S'},
                    {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                    {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
                ],
                GlobalSecondaryIndexes=[{
                    'IndexName': 'GeohashIndex',
                    'KeySchema': [{'AttributeName': 'GSI1PK', 'KeyType': 'HASH'}, {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'}],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5
                    }
                }],
                BillingMode='PROVISIONED',
                ProvisionedThroughput={'ReadCapacityUnits': 20, 'WriteCapacityUnits': 20}
            )
            table.meta.client.get_waiter('table_exists').wait(TableName=table_name)
            self.stdout.write(self.style.SUCCESS(f"Table '{table_name}' created successfully!"))