---
title: Getting Started with MDF
---

# Getting Started with MDF

MDF-compliant servers expose markdown via standard HTTP content negotiation. No new protocol, no new port.

## Making your first request

Send an Accept header indicating markdown preference and the server responds with raw markdown source plus MDF headers.

## Discovery

Fetch `/mdf.json` to discover pricing, payment endpoints, and content signals for the entire site.
