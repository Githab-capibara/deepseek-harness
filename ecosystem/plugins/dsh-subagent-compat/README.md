# dsh-subagent-compat

Compatibility shim for DSH 0.2.x hosts.

`dsh-swarm-orchestrator` 0.6.x spawns its task agents through the legacy
subagent entry point:

```js
await ctx.get('subagents').start('spawn', request)
```

DSH 0.2.2-rc.1 replaced that method with `startActivation({ provider, label,
request, signal, delivery })`, so every swarm task agent failed with
`subagents.start is not a function` and the run was reported as failed.

This plugin adds the legacy `start()` method back onto the `subagents`
service instance, forwarding it to `startActivation()` and mapping the
receipt (`childId`) onto the legacy run shape (`id`). Role personas are
folded into the child prompt, because the 0.2.x request contract dropped the
`persona` field.

Nothing else is changed: when the host still provides `start()`, the plugin
does nothing at all.
