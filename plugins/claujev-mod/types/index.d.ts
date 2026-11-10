// What Jev decided about one tool call, kept by the call's tool_use_id.
export type Verdict = {
  hook: 'bash' | 'edit'
  acted: boolean
  detail?: string
  skipped?: string
}

// One line of the activity pane.
export type Activity = {
  ts: string
  hook: string
  acted: boolean
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'claujev-mod': {
      verdicts: Shaped<Record<string, Verdict>>
      activity: Shaped<Activity[]>
    }
  }
}
