// Golden-angle spacing keeps consecutive project hues well separated.
function pastelColor(index: number): string {
  const hue = (210 + index * 137.508) % 360
  return `hsl(${hue.toFixed(3)} 65% 75%)`
}

function isPastelColor(color: string): boolean {
  const match = /^hsl\((\d+\.\d{3}) 65% 75%\)$/.exec(color)
  return match !== null && Number(match[1]) < 360
}

export function nextWorkspaceColor(workspaces: readonly { color: string }[]): string {
  const used = new Set(workspaces.map((workspace) => workspace.color))
  for (let index = 0; ; index++) {
    const color = pastelColor(index)
    if (!used.has(color)) return color
  }
}

/** Repair old or duplicate identifiers without changing other projects' colors. */
export function reconcileWorkspaceColors(workspaces: { color: string }[]): boolean {
  const reserved: { color: string }[] = []
  const used = new Set<string>()
  const pending: { color: string }[] = []
  for (const workspace of workspaces) {
    if (isPastelColor(workspace.color) && !used.has(workspace.color)) {
      used.add(workspace.color)
      reserved.push(workspace)
    } else {
      pending.push(workspace)
    }
  }
  for (const workspace of pending) {
    workspace.color = nextWorkspaceColor(reserved)
    reserved.push(workspace)
  }
  return pending.length > 0
}
