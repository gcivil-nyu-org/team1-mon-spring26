"""
ASGI config for django_map project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os
import django
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from django.conf import settings
from asgiref.sync import sync_to_async
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import StreamingResponse, JSONResponse
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "django_map.settings")
django.setup()

logger = logging.getLogger(__name__)

# Global Pub/Sub Memory: Maps user_id (str) to a set of asyncio.Queues
active_connections = {}


async def get_user_id_from_session(request):
    session_key = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not session_key:
        return None

    from django.contrib.sessions.models import Session

    try:
        session = await sync_to_async(Session.objects.get)(session_key=session_key)
        data = session.get_decoded()
        return str(data.get("_auth_user_id"))
    except Session.DoesNotExist:
        return None


async def internal_publish(request):
    """
    Internal endpoint to receive events from the synchronous WSGI application
    and broadcast them to connected SSE clients.
    """
    client_host = request.client.host
    if client_host not in ("127.0.0.1", "localhost", "::1"):
        return JSONResponse({"error": "Unauthorized"}, status_code=403)

    try:
        data = await request.json()
        target_user_id = str(data.get("user_id"))
        payload_str = data.get("payload")

        if target_user_id in active_connections:
            for q in active_connections[target_user_id]:
                q.put_nowait(payload_str)
        return JSONResponse({"status": "ok"})
    except Exception as e:
        logger.error("[SSE] Error publishing event: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


async def chat_events_sse(request):
    user_id = await get_user_id_from_session(request)
    if not user_id:
        return StreamingResponse(
            iter(['data: {"error": "unauthorized"}\n\n']),
            media_type="text/event-stream",
        )

    queue = asyncio.Queue()
    if user_id not in active_connections:
        active_connections[user_id] = set()
    active_connections[user_id].add(queue)

    async def event_generator():
        yield "retry: 60000\n\n"
        event_id = 0
        try:
            while True:
                try:
                    # Wait for either a new message or a keep-alive timeout
                    payload = await asyncio.wait_for(queue.get(), timeout=55.0)
                    event_id += 1
                    yield f"id: {event_id}\ndata: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            # Safely cleanup connection from memory
            active_connections[user_id].remove(queue)
            if not active_connections[user_id]:
                del active_connections[user_id]

    response = StreamingResponse(
        event_generator(), media_type="text/event-stream; charset=utf-8"
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["X-Accel-Buffering"] = "no"
    return response


# Allow frontend running on port 8000 to connect locally and send cookies
middleware = [
    Middleware(
        CORSMiddleware,
        # Matches any subdomain of amenity.help (e.g., feature.amenity.help)
        # and the root domain amenity.help itself.
        allow_origin_regex=r"https://([a-zA-Z0-9-]+\.)?amenity\.help",
        allow_origins=[
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ],
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["*"],
    )
]


application = Starlette(
    routes=[
        Route("/api/chats/events/", chat_events_sse),
        Route("/api/internal/publish/", internal_publish, methods=["POST"]),
    ],
    middleware=middleware,
)
