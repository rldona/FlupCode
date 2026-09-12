import { For, Show, type Component } from "solid-js"

export type TodoItem = {
  content: string
  status: string
}

type TodoDockProps = {
  todos: TodoItem[]
}

const mark = (status: string) => {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  return "○"
}

export const TodoDock: Component<TodoDockProps> = (props) => (
  <Show when={props.todos.length > 0}>
    <div class="fc-dock fc-todo-dock">
      <div class="fc-dock-header">
        <span class="fc-dock-title">Tareas</span>
      </div>
      <ul class="fc-todo-list">
        <For each={props.todos}>
          {(todo) => (
            <li class="fc-todo" classList={{ "fc-todo-done": todo.status === "completed" }}>
              <span class="fc-todo-mark">{mark(todo.status)}</span>
              <span>{todo.content}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  </Show>
)
