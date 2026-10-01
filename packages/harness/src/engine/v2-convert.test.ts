import { expect, test } from "bun:test"
import type {
  FormInfo as V2Form,
  IntegrationInfo as V2Integration,
  ModelInfo as V2Model,
  ProviderInfo as V2Provider,
  SessionInfo as V2Session,
  SessionMessageInfo as V2Message,
} from "@opencode/client"
import { toFormAnswer, toMessages, toModel, toProviderDirectory, toQuestion, toSession } from "./v2-convert"

const session = {
  id: "ses_1",
  projectID: "prj_1",
  cost: 0.25,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/work/demo" },
  permissions: [{ action: "shell", resource: "*", effect: "ask" }],
} as unknown as V2Session

test("a 2.x session keeps its fields and turns its permission rules into the app's shape", () => {
  expect(toSession(session)).toEqual({
    id: "ses_1",
    projectID: "prj_1",
    cost: 0.25,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "",
    location: { directory: "/work/demo" },
    permission: [{ permission: "bash", pattern: "*", action: "ask" }],
  })
})

test("a 2.x session with a title and a parent keeps both", () => {
  const child = toSession({ ...session, title: "Child", parentID: "ses_0" } as V2Session)
  expect(child.title).toBe("Child")
  expect(child.parentID).toBe("ses_0")
})

const assistant = {
  id: "msg_2",
  type: "assistant",
  time: { created: 3, completed: 4 },
  agent: "build",
  model: { id: "m", providerID: "p" },
  content: [
    { type: "text", text: "Hello" },
    { type: "reasoning", text: "Thinking" },
    { type: "tool", id: "call_1", name: "read", time: { created: 3 }, state: { status: "streaming", input: '{"pa' } },
    {
      type: "tool",
      id: "call_2",
      name: "read",
      time: { created: 3, ran: 3, completed: 4 },
      state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "ok" }] },
    },
    {
      type: "tool",
      id: "call_3",
      name: "shell",
      time: { created: 3 },
      state: { status: "error", input: {}, error: { type: "denied", message: "No" } },
    },
  ],
  cost: 0.5,
  error: { type: "aborted", message: "Interrupted" },
} as unknown as V2Message

test("an assistant's content gets stable ids, the app's tool states and an unknown-typed error", () => {
  const [converted] = toMessages([assistant])
  expect(converted).toMatchObject({
    id: "msg_2",
    type: "assistant",
    cost: 0.5,
    error: { type: "unknown", message: "Interrupted" },
    content: [
      { type: "text", id: "msg_2:0", text: "Hello" },
      { type: "reasoning", id: "msg_2:1", text: "Thinking" },
      { type: "tool", id: "call_1", state: { status: "pending", input: '{"pa' } },
      {
        type: "tool",
        id: "call_2",
        state: { status: "completed", content: [{ type: "text", text: "ok" }], structured: {} },
      },
      {
        type: "tool",
        id: "call_3",
        state: { status: "error", content: [], error: { type: "unknown", message: "No" } },
      },
    ],
  })
})

test("kinds the app has no view for are dropped, and a running compaction waits for its summary", () => {
  const messages = [
    { id: "m1", type: "user", time: { created: 1 }, text: "hi" },
    { id: "m2", type: "idle", time: { created: 2 }, outcome: "succeeded" },
    { id: "m3", type: "location-switched", time: { created: 3 } },
    { id: "m4", type: "compaction", status: "running", time: { created: 4 }, reason: "manual" },
    {
      id: "m5",
      type: "compaction",
      status: "completed",
      time: { created: 5 },
      reason: "manual",
      summary: "S",
      recent: "R",
    },
    { id: "m6", type: "agent-switched", time: { created: 6 }, agent: "plan" },
    {
      id: "m7",
      type: "shell",
      time: { created: 7 },
      shellID: "sh_1",
      command: "ls",
      status: "exited",
      output: { output: "a\n", cursor: 0, size: 2, truncated: false },
    },
  ] as unknown as V2Message[]
  expect(toMessages(messages).map((message) => message.type)).toEqual(["user", "compaction", "agent-switched", "shell"])
  expect(toMessages(messages).at(-1)).toMatchObject({ callID: "sh_1", command: "ls", output: "a\n" })
})

test("a user's inline file becomes a data URL, a linked one keeps its URI", () => {
  const [user] = toMessages([
    {
      id: "m1",
      type: "user",
      time: { created: 1 },
      text: "look",
      files: [
        { data: "aGk=", mime: "text/plain", source: { type: "inline" }, name: "a.txt" },
        { data: "", mime: "image/png", source: { type: "uri", uri: "file:///b.png" } },
      ],
    } as unknown as V2Message,
  ])
  expect(user).toMatchObject({
    files: [
      { uri: "data:text/plain;base64,aGk=", mime: "text/plain", name: "a.txt" },
      { uri: "file:///b.png", mime: "image/png" },
    ],
  })
})

const form = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Setup",
  fields: [
    { key: "confirm", type: "boolean", title: "Continue?" },
    { key: "count", type: "integer", title: "How many", description: "Workers to start" },
    { key: "secret", type: "string", hidden: true },
    { key: "docs", type: "external", url: "https://example.com" },
    { key: "mode", type: "string", title: "Mode", options: [{ value: "fast", label: "Fast" }] },
  ],
} as unknown as V2Form

test("a form from anything but the question tool reads field by field, hidden and external ones left out", () => {
  expect(toQuestion(form)).toEqual({
    id: "frm_1",
    sessionID: "ses_1",
    questions: [
      {
        question: "Continue?",
        header: "Continue?",
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        custom: false,
      },
      { question: "Workers to start", header: "How many", options: [], custom: true },
      { question: "Mode", header: "Mode", options: [{ label: "Fast", description: "" }], custom: false },
    ],
  })
})

test("the dock's answers go back typed by field, a picked option as its value", () => {
  expect(toFormAnswer(form, [["Yes"], ["3"], ["Fast"]])).toEqual({ confirm: true, count: 3, mode: "fast" })
  // A question left unanswered is left out of the answer.
  expect(toFormAnswer(form, [[], ["3"]])).toEqual({ count: 3 })
})

const model = {
  id: "gpt",
  modelID: "gpt",
  providerID: "openai",
  name: "GPT",
  package: "@ai-sdk/openai",
  settings: { apiKey: "sk-never", baseURL: "https://api.example.com" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
  time: { released: 1 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 1000, output: 100 },
} as unknown as V2Model

test("a 2.x model keeps what the app reads and never its settings, which can hold the key", () => {
  const converted = toModel(model)
  expect(converted).toMatchObject({
    id: "gpt",
    providerID: "openai",
    variants: [{ id: "high" }],
    limit: { context: 1000 },
  })
  expect(JSON.stringify(converted)).not.toContain("sk-never")
})

test("the provider directory is every integration, with config providers told apart and models counted", () => {
  const integrations = [
    { id: "openai", name: "OpenAI", methods: [{ type: "env", names: ["OPENAI_API_KEY"] }], connections: [] },
  ] as unknown as V2Integration[]
  const providers = [
    { id: "openai", integrationID: "openai", name: "OpenAI", activation: "auto", package: "x" },
    { id: "mine", name: "Mine", activation: "enabled", package: "x" },
    { id: "off", name: "Off", activation: "disabled", package: "x" },
  ] as unknown as V2Provider[]
  const directory = toProviderDirectory({ integrations, providers, models: [model] })
  expect(directory.all.map((item) => [item.id, item.source, item.env, Object.keys(item.models)])).toEqual([
    ["openai", "api", ["OPENAI_API_KEY"], ["gpt"]],
    ["mine", "config", [], []],
    ["off", "config", [], []],
  ])
  expect(directory.connected).toEqual(["openai", "mine"])
})
