from http.server import BaseHTTPRequestHandler

from vercel_backend import handle


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        handle(self)

    def do_POST(self):
        handle(self)
