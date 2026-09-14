# @motion-probe/mcp

MCP server for [motion-probe](https://github.com/CraftsManShip001/motion-probe): lets coding agents
(Claude Code, Cursor, …) record React Native animations from what the native view layer renders and
verify them against specs — no screen recordings, a few lines of text per check.

```json
{
  "mcpServers": {
    "motion-probe": { "command": "npx", "args": ["-y", "-p", "@motion-probe/mcp", "motion-probe-mcp"] }
  }
}
```

The app needs [`@motion-probe/react-native`](https://www.npmjs.com/package/@motion-probe/react-native)
(`if (__DEV__) installMotionProbe()`).

| Tool | |
|---|---|
| `motion_record` | arm → `command` / `trigger` → settle → report (+ PASS/FAIL with a spec) |
| `motion_arm` / `motion_report` | when another tool (Maestro, mobile MCP, …) performs the interaction |
| `motion_send` | run a handler the app registered with `onMotionProbeCommand` |
| `motion_baseline` | turn the last recording into a regression spec |
| `motion_spec_from_tokens` | build a spec from design motion tokens |
| `motion_analyze` | re-analyze a saved trace |
| `motion_status`, `motion_easings` | connection state, easing names |

The server hosts the local daemon while it runs, so the app stays connected between tool calls.
Environment: `MOTION_PROBE_PORT` (default 7357), `MOTION_PROBE_HOST`.

## License

MIT
