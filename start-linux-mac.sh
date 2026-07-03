#!/bin/sh
PORT=${PORT:-3000} ADMIN_PASSWORD=${ADMIN_PASSWORD:-1234} APP_SECRET=${APP_SECRET:-change-this-secret-before-public-hosting} node server.js
