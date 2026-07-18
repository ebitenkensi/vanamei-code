let _active = false

export function activate() {
  _active = true
}

export function active() {
  return _active
}

export * as DetachState from "./detach-state"
