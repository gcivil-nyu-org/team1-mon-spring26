# Generated migration

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("maps", "0006_chat_chatparticipant_message"),
    ]

    operations = [
        migrations.AddField(
            model_name="amenityphoto",
            name="review",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="photos",
                to="maps.review",
            ),
        ),
    ]
