# Changelog

## 1.0.0

- Initial release as a SignalK plugin
- HTTP reverse proxy that forwards requests to a configurable target URL
- UDP multicast announcements to B&G/Navico MFDs (group 239.2.1.1, port 2053)
- Automatic IP detection with optional manual override
- HTML polyfill injection for MFD's older embedded Chromium (< Chrome 73)
- JavaScript transpilation to Chrome 70 target via esbuild
- WebSocket upgrade forwarding
