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
    <div class="oh-dock oh-todo-dock">
      <div class="oh-dock-header">
        <span class="oh-dock-title">Tareas</span>
      </div>
      <ul class="oh-todo-list">
        <For each={props.todos}>
          {(todo) => (
            <li class="oh-todo" classList={{ "oh-todo-done": todo.status === "completed" }}>
              <span class="oh-todo-mark">{mark(todo.status)}</span>
              <span>{todo.content}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  </Show>
)
