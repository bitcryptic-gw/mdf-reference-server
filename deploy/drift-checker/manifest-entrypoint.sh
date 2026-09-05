#!/bin/sh
# entrypoint for mdf-manifest-public: crond (busybox) + nginx.
set -e
crond -b -l 8
exec nginx -g 'daemon off;'
