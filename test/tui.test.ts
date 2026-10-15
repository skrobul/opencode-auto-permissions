import { describe, expect, test } from "bun:test"
import plugin from "../src/tui.ts"
import type { Context } from "@opencode-ai/plugin/tui/plugin"

function context(version: string): { context: Context; subscriptions: string[] } {
  const subscriptions: string[] = []
  return {
    context: {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        global: { health: async () => ({ data: { healthy: true, version } }) },
      },
      data: {
        on(type: string) {
          subscriptions.push(type)
          return () => {}
        },
        session: {
          root: (id: string) => id,
          get: (id: string) => ({ id }),
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => [], sync: async () => {} },
        },
      },
      ui: { toast: { show() {} } },
    } as unknown as Context,
    subscriptions,
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe("TUI plugin runtime ownership", () => {
  test("owns V2 permission events", async () => {
    const app = context("0.0.0-beta-202608040144")

    const dispose = await plugin.setup(app.context)

    expect(app.subscriptions).toEqual([
      "permission.v2.replied",
      "permission.replied",
      "permission.v2.asked",
      "permission.asked",
    ])
    expect(typeof dispose).toBe("function")
    dispose?.()
  })
})

describe("TUI plugin denial continuation", () => {
  function continuationHarness(status: () => string) {
    const handlers = new Map<string, Set<(event: unknown) => void>>()
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const pending = [
      { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["sudo rm -rf /"], save: [] },
    ]
    const app: Context = {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        permission: {
          reply: async (input: Record<string, unknown>) => {
            replies.push(input)
            pending.length = 0
          },
        },
        session: {
          prompt: async (input: Record<string, unknown>) => {
            prompts.push(input)
          },
        },
      },
      data: {
        on(type: string, handler: (event: unknown) => void) {
          const set = handlers.get(type) ?? new Set()
          set.add(handler)
          handlers.set(type, set)
          return () => set.delete(handler)
        },
        session: {
          root: (id: string) => id,
          get: (id: string) => ({ id }),
          status,
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => pending, sync: async () => {} },
        },
      },
      ui: { toast: { show() {} } },
    } as unknown as Context
    return { app, handlers, replies, prompts, pending }
  }

  async function emitDenial(app: Context, handlers: Map<string, Set<(event: unknown) => void>>, pending: unknown[]) {
    const dispose = await plugin.setup(app)
    try {
      const emit = (type: string, data: unknown) => {
        for (const handler of handlers.get(type) ?? []) handler({ type, data })
      }
      emit("permission.asked", pending[0])
      await settle()
    } finally {
      dispose?.()
    }
  }

  test("steers the denial reason into a running session", async () => {
    const app = continuationHarness(() => "running")

    await emitDenial(app.app, app.handlers, app.pending)

    expect(app.replies).toHaveLength(1)
    expect(app.replies[0]).toMatchObject({
      sessionID: "ses_root",
      requestID: "per_1",
      reply: "reject",
      message: expect.stringContaining("blocked"),
    })
    expect(app.prompts).toHaveLength(1)
    const continuation = String(app.prompts[0]?.text)
    expect(app.prompts[0]).toMatchObject({ sessionID: "ses_root", delivery: "steer" })
    expect(app.prompts[0]).not.toHaveProperty("resume")
    expect(continuation).toContain("[Auto Permissions] The requested action was blocked:")
    expect(continuation).toContain("Do not retry the exact blocked action")
  })

  test("shows the interactive denial choices and approves only once when selected", async () => {
    const app = continuationHarness(() => "idle")
    const interactiveApp = {
      ...app.app,
      options: { ...app.app.options, interactiveDenials: true },
      ui: {
        ...app.app.ui,
        router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      },
    } as unknown as Context
    let dialogTitle = ""
    let dialogSize = ""
    let optionTitles: string[] = []
    ;(interactiveApp.ui as unknown as {
      dialog: {
        select(input: { title: string; options: Array<{ title: string }> }): Promise<string>
        set(input: { size?: string }): void
      }
    }).dialog = {
      async select(input) {
        dialogTitle = input.title
        optionTitles = input.options.map((option) => option.title)
        return "approve"
      },
      set(input) {
        dialogSize = input.size ?? ""
      },
    }

    await emitDenial(interactiveApp, app.handlers, app.pending)

    expect(dialogTitle).toBe("Command blocked: sudo rm -rf /")
    expect(dialogSize).toBe("xlarge")
    expect(optionTitles).not.toContain("Use safer approach")
    expect(app.replies).toHaveLength(1)
    expect(app.replies[0]).toMatchObject({ sessionID: "ses_root", requestID: "per_1", reply: "once" })
    expect(app.prompts).toEqual([])
  })

  test("offers the classifier's safer alternative and relays that exact option", async () => {
    const app = continuationHarness(() => "idle")
    app.pending[0]!.resources = ["touch .approval-marker"]
    const client = app.app.client as any
    client.permission.request = { list: async () => ({ data: [] }) }
    client.permission.reply = async (input: Record<string, unknown>) => {
      app.replies.push({ ...input, reply: input.decision })
      app.pending.length = 0
    }
    client.session.create = async () => ({ id: "ses_review" })
    client.session.generate = async () => ({
      text: JSON.stringify({
        decision: "deny",
        reasonCode: "user_prohibition",
        reason: "The requested command was explicitly prohibited.",
        alternatives: ["Explain how to remove the marker manually without running the command."],
      }),
    })
    client.session.remove = async () => {}

    const interactiveApp = {
      ...app.app,
      options: { ...app.app.options, interactiveDenials: true },
      ui: {
        ...app.app.ui,
        router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      },
    } as unknown as Context
    let options: Array<{ title: string; value: string; description?: string }> = []
    let selectedValue = ""
    ;(interactiveApp.ui as unknown as {
      dialog: {
        select(input: { options: Array<{ title: string; value: string; description?: string }> }): Promise<string>
        set(input: { size?: string }): void
      }
    }).dialog = {
      async select(input) {
        options = input.options
        selectedValue = "alternative:0"
        return selectedValue
      },
      set() {},
    }

    await emitDenial(interactiveApp, app.handlers, app.pending)

    const saferOption = options.find((option) => option.value === selectedValue)
    expect(saferOption).toMatchObject({
      title: "Use safer approach",
      description: "Explain how to remove the marker manually without running the command.",
    })
    expect(String(app.prompts[0]?.text)).toContain(
      "User-selected direction: Follow this reviewer-proposed safer alternative: Explain how to remove the marker manually without running the command.",
    )
    expect(String(app.prompts[0]?.text)).toContain("The requested command was explicitly prohibited.")
  })

  test("presents custom input as the user's chosen next step, distinct from the denial", async () => {
    const app = continuationHarness(() => "idle")
    app.pending[0]!.resources = ["touch .approval-marker"]
    const client = app.app.client as any
    client.permission.request = { list: async () => ({ data: [] }) }
    client.permission.reply = async (input: Record<string, unknown>) => {
      app.replies.push({ ...input, reply: input.decision })
      app.pending.length = 0
    }
    client.session.create = async () => ({ id: "ses_review" })
    client.session.generate = async () => ({
      text: JSON.stringify({
        decision: "deny",
        reasonCode: "user_prohibition",
        reason: "The user explicitly prohibited this action.",
        alternatives: [],
      }),
    })
    client.session.remove = async () => {}

    const interactiveApp = {
      ...app.app,
      options: { ...app.app.options, interactiveDenials: true },
      ui: {
        ...app.app.ui,
        router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      },
    } as unknown as Context
    const customDirection = "Create the marker with a Python script instead."
    ;(interactiveApp.ui as unknown as { dialog: Record<string, unknown> }).dialog = {
      async select() { return "custom" },
      async prompt() { return customDirection },
      set() {},
    }

    await emitDenial(interactiveApp, app.handlers, app.pending)

    expect(app.replies[0]).toMatchObject({ requestID: "per_1", reply: "reject" })
    expect(app.prompts).toHaveLength(1)
    const continuation = String(app.prompts[0]?.text)
    expect(continuation).toContain(`User-selected direction: ${customDirection}`)
    expect(continuation).toContain("This denial applies to that call only")
    expect(continuation).toContain("Do not retry the exact blocked call")
  })

  test("does not open a denial dialog in a different active session", async () => {
    const app = continuationHarness(() => "idle")
    const otherSessionApp = {
      ...app.app,
      options: { ...app.app.options, interactiveDenials: true },
      ui: {
        ...app.app.ui,
        router: { current: () => ({ type: "session", sessionID: "ses_other" }) },
      },
    } as unknown as Context
    let dialogCalls = 0
    ;(otherSessionApp.ui as unknown as { dialog: { select(): Promise<string> } }).dialog = {
      async select() {
        dialogCalls++
        return "stop"
      },
    }

    await emitDenial(otherSessionApp, app.handlers, app.pending)

    expect(dialogCalls).toBe(0)
    expect(app.replies).toEqual([])
  })

  test("resumes an idle session with the denial reason", async () => {
    const app = continuationHarness(() => "idle")

    await emitDenial(app.app, app.handlers, app.pending)

    expect(app.prompts).toHaveLength(1)
    const continuation = String(app.prompts[0]?.text)
    expect(app.prompts[0]).toMatchObject({ sessionID: "ses_root", resume: true })
    expect(app.prompts[0]).not.toHaveProperty("delivery")
    expect(continuation).toContain("[Auto Permissions] The requested action was blocked:")
  })

  test("falls back to a resume prompt when steering fails", async () => {
    const app = continuationHarness(() => "running")
    let calls = 0
    const realPrompt = app.app.client.session.prompt as (input: Record<string, unknown>) => Promise<unknown>
    ;(app.app.client as { session: { prompt: unknown } }).session.prompt = async (input: Record<string, unknown>) => {
      calls++
      if (calls === 1) {
        app.prompts.push(input)
        throw new Error("no active run")
      }
      return realPrompt(input)
    }

    await emitDenial(app.app, app.handlers, app.pending)

    expect(calls).toBe(2)
    expect(app.prompts[0]).toMatchObject({ sessionID: "ses_root", delivery: "steer" })
    expect(app.prompts[1]).toMatchObject({ sessionID: "ses_root", resume: true })
  })

  test("steers through the legacy V2 client shape when the flat prompt is unavailable", async () => {
    const app = continuationHarness(() => "running")
    const client = app.app.client as {
      permission?: { reply?: unknown }
      session?: { prompt?: unknown }
      v2?: { session?: { prompt?: (input: Record<string, unknown>) => Promise<unknown> } }
    }
    client.session = { prompt: undefined }
    client.v2 = {
      session: {
        prompt: async (input: Record<string, unknown>) => {
          app.prompts.push(input)
        },
      },
    }

    await emitDenial(app.app, app.handlers, app.pending)

    expect(app.prompts).toHaveLength(1)
    expect(app.prompts[0]).toMatchObject({ sessionID: "ses_root", delivery: "steer", resume: true })
    expect(String((app.prompts[0]?.prompt as { text?: string }).text)).toContain(
      "[Auto Permissions] The requested action was blocked:",
    )
  })

  test("resumes through the legacy V2 client after a rejection", async () => {
    const handlers = new Map<string, Set<(event: unknown) => void>>()
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const pending = [
      { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["sudo rm -rf /"], always: [] },
    ]

    const api = {
      client: {
        permission: {
          reply: async (input: Record<string, unknown>) => {
            replies.push(input)
            pending.length = 0
          },
        },
        v2: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              prompts.push(input)
            },
          },
        },
      },
      state: {
        session: {
          get: (id: string) => ({ id }),
          messages: () => [],
          permission: () => pending,
        },
        part: () => [],
        path: { directory: "/repo" },
      },
      event: {
        on(type: string, handler: (event: unknown) => void) {
          const set = handlers.get(type) ?? new Set()
          set.add(handler)
          handlers.set(type, set)
          return () => set.delete(handler)
        },
      },
      ui: { toast() {} },
      lifecycle: { onDispose() {} },
    }

    await plugin.tui(api as never, {})
    const emit = (type: string, data: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler({ type, data })
    }
    emit("permission.v2.asked", pending[0])
    await settle()

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ reply: "reject", requestID: "per_1" })
    expect(prompts).toHaveLength(1)
    const continuation = String((prompts[0]?.prompt as { text?: string } | undefined)?.text)
    expect(prompts[0]).toMatchObject({ sessionID: "ses_root", delivery: "queue", resume: true })
    expect(continuation).toContain("[Auto Permissions] The requested action was blocked:")
  })
})
