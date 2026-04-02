from django.middleware.gzip import GZipMiddleware

class SelectiveGZipMiddleware(GZipMiddleware):
    """
    A custom GZip middleware that skips compression for Server-Sent Events (SSE)
    to prevent proxy and browser buffering issues.
    """
    def process_response(self, request, response):
        if "text/event-stream" in response.get("Content-Type", ""):
            return response
        return super().process_response(request, response)