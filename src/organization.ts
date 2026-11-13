import { bulkOrganize, updateCollection, type Library } from './library'

export type OrganizationDrag = { kind: 'bookmarks'; ids: string[]; scope: string; baseline: Library } | { kind: 'collection'; id: string; scope: string; baseline: Library }
export const organizationMime = 'application/x-bookmark-desk-organization'

export function validateOrganizationDrop(library: Library, drag: OrganizationDrag, scope: string, target: string | null): void {
  if (drag.baseline !== library || drag.scope !== scope) throw new Error('Library or selection scope changed. Start dragging again.')
  if (target !== null && !library.collections.some(c => c.id === target)) throw new Error('Drop onto a normal collection only.')
  if (drag.kind === 'bookmarks') {
    const activeIds = new Set(library.bookmarks.map(b => b.id))
    if (target === null || !drag.ids.length || new Set(drag.ids).size !== drag.ids.length || drag.ids.some(id => !activeIds.has(id))) throw new Error('Invalid bookmark selection. Select active bookmarks again.')
    return
  }
  if (!library.collections.some(c => c.id === drag.id)) throw new Error('Collection not found.')
  let parent = target
  const visited = new Set<string>()
  while (parent !== null) {
    if (parent === drag.id || visited.has(parent)) throw new Error('A collection cannot be moved into itself or a descendant.')
    visited.add(parent)
    parent = library.collections.find(c => c.id === parent)?.parentId ?? null
  }
}
export function organizationDrop(library: Library, drag: OrganizationDrag, scope: string, target: string | null): Library {
  validateOrganizationDrop(library, drag, scope, target)
  if (drag.kind === 'bookmarks') return bulkOrganize(library, new Set(drag.ids), 'move', [target!])
  const collection = library.collections.find(c => c.id === drag.id)!
  return updateCollection(library, collection.id, collection.name, target)
}
