# Generated migration for chat models

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("maps", "0002_amenity_friday_close_amenity_friday_open_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="Chat",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "chat_type",
                    models.CharField(
                        choices=[
                            ("direct", "Direct Message"),
                            ("group", "Group Chat"),
                            ("amenity_forum", "Amenity Forum"),
                        ],
                        default="direct",
                        max_length=20,
                    ),
                ),
                (
                    "name",
                    models.CharField(
                        blank=True,
                        help_text="Custom name for group and forum chats",
                        max_length=200,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("last_message_at", models.DateTimeField(auto_now_add=True)),
                (
                    "amenity",
                    models.ForeignKey(
                        blank=True,
                        help_text="For amenity forum chats, reference the amenity being discussed",
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chats",
                        to="maps.amenity",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="created_chats",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-last_message_at"],
            },
        ),
        migrations.CreateModel(
            name="Message",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("content", models.TextField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "chat",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="messages",
                        to="maps.chat",
                    ),
                ),
                (
                    "sender",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sent_messages",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["created_at"],
            },
        ),
        migrations.CreateModel(
            name="ChatParticipant",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("joined_at", models.DateTimeField(auto_now_add=True)),
                ("last_read_at", models.DateTimeField(blank=True, null=True)),
                (
                    "chat",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="participants",
                        to="maps.chat",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chat_participations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["joined_at"],
                "unique_together": {("chat", "user")},
            },
        ),
        migrations.AddIndex(
            model_name="message",
            index=models.Index(
                fields=["chat", "-created_at"], name="maps_messag_chat_id_created_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="message",
            index=models.Index(
                fields=["sender", "-created_at"], name="maps_messag_sender__created_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="chatparticipant",
            index=models.Index(
                fields=["user", "-joined_at"], name="maps_chatpa_user_id_joined_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="chat",
            index=models.Index(
                fields=["-last_message_at"], name="maps_chat_last_messa_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="chat",
            index=models.Index(
                fields=["chat_type", "-last_message_at"],
                name="maps_chat_chat_ty_last_messag_idx",
            ),
        ),
    ]
