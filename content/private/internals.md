---
title: Internal Architecture Notes
---

# Internal Architecture Notes

This document is priced at $0.10. At this tier, payment issues a bearer token rather than delivering content directly: the token is scoped to `/private/`, valid for 24 hours, and reusable across requests to that scope.

## Token-based access

After payment verification, the server issues a time-limited bearer token. Subsequent requests include the token in the Authorization header.
