import { describe, expect, test } from "bun:test"
import { workflowGraph } from "./workflow-graph"
import type { Workflow } from "./types"

const task = (id: string, over: Partial<Workflow["tasks"][number]> = {}): Workflow["tasks"][number] => ({
  id,
  kind: "agent",
  ...over,
})

describe("laying a workflow out as a graph (H-28)", () => {
  test("a chain is one column per step", () => {
    const graph = workflowGraph([task("plan"), task("build"), task("verify", { kind: "verify" })])
    expect(graph.nodes.map((node) => `${node.id}@${node.depth}`)).toEqual(["plan@0", "build@1", "verify@2"])
    expect(graph.columns).toBe(3)
    expect(graph.edges).toEqual([
      { from: "plan", to: "build" },
      { from: "build", to: "verify" },
    ])
  })

  test("an external task is drawn as what it is (H-38)", () => {
    const graph = workflowGraph([task("codex", { kind: "external" })])
    expect(graph.nodes[0]!.kind).toBe("external")
  })

  test("tasks that can run together share a column", () => {
    const graph = workflowGraph([
      task("read"),
      task("left", { dependsOn: ["read"] }),
      task("right", { dependsOn: ["read"] }),
      task("join", { dependsOn: ["left", "right"] }),
    ])
    // The two that wait on `read` are at the same depth, which is what the runner will do with them.
    expect(graph.nodes.find((node) => node.id === "left")!.depth).toBe(1)
    expect(graph.nodes.find((node) => node.id === "right")!.depth).toBe(1)
    expect(graph.nodes.find((node) => node.id === "join")!.depth).toBe(2)
    expect(graph.columns).toBe(3)
  })

  test("`parallel` takes a task out of the chain, and `when` names a dependency", () => {
    const graph = workflowGraph([
      task("a"),
      task("b", { parallel: true }),
      task("recover", { when: { task: "b", is: ["failed"] } }),
    ])
    expect(graph.nodes.find((node) => node.id === "b")!.depth).toBe(0)
    expect(graph.nodes.find((node) => node.id === "b")!.dependsOn).toEqual([])
    // `recover` waits for `b` even though it never said `dependsOn`.
    expect(graph.nodes.find((node) => node.id === "recover")!.dependsOn).toEqual(["b"])
    expect(graph.nodes.find((node) => node.id === "recover")!.depth).toBe(1)
  })

  test("a `foreach` waits for the plan it splits", () => {
    const graph = workflowGraph([task("plan"), task("step", { foreach: "plan" })])
    expect(graph.nodes.find((node) => node.id === "step")!.dependsOn).toEqual(["plan"])
    expect(graph.nodes.find((node) => node.id === "step")!.depth).toBe(1)
  })

  test("a gate is carried so the picture can mark it", () => {
    const graph = workflowGraph([task("plan", { gate: "human" }), task("verify", { kind: "verify" })])
    expect(graph.nodes[0]!.gate).toBe(true)
    expect(graph.nodes[1]!.kind).toBe("verify")
  })
})
