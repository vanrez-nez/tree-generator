// Composes the `layers` blade with per-layer Tweakpane control folders. Each layer type
// defines its own controls via a `build(folder, layer)` callback; selecting a layer shows
// that layer's folder and hides the others. The blade owns the Add/Remove footer (and its
// type-picker menu + confirm dialog); this helper reacts to its events and manages folders.
import type { ContainerApi, FolderApi } from '@tweakpane/core'
import {
  type LayerItem,
  LayersBladeApi,
  LayersPluginBundle,
} from './layers-blade'

export { LayersPluginBundle }

export type LayerHandle<T = unknown> = {
  readonly id: string
  readonly type: string
  name: string
  visible: boolean
  state: T
}

export type LayerType<T = any> = {
  /** Display name; also the label shown in the "Add Layer" menu. */
  name: string
  /** Populate the per-layer control folder with normal Tweakpane bindings. */
  build: (folder: FolderApi, layer: LayerHandle<T>) => void
  /** Create the per-layer control state object bound by `build`. */
  createState?: () => T
}

export type CreateLayersOptions = {
  title?: string
  addLabel?: string
  types: LayerType[]
  onSelect?: (layer: LayerHandle | null) => void
  onVisibility?: (layer: LayerHandle) => void
  onAdd?: (layer: LayerHandle) => void
  onRemove?: (layer: LayerHandle) => void
  onReorder?: (layers: LayerHandle[]) => void
}

export type LayersController = {
  /** Programmatically add a layer of the given type name. */
  addLayer: (typeName: string) => LayerHandle | null
  getLayers: () => LayerHandle[]
  blade: LayersBladeApi
  folder: FolderApi
}

type LayerRecord = {
  id: string
  type: string
  handle: LayerHandle
  folder: FolderApi
}

export function createLayers(
  container: ContainerApi,
  options: CreateLayersOptions,
): LayersController {
  const types = new Map(options.types.map((type) => [type.name, type]))
  const records = new Map<string, LayerRecord>()
  let counter = 0

  const folder = container.addFolder({ title: options.title ?? 'Layers' })
  const blade = folder.addBlade({
    view: 'layers',
    addLabel: options.addLabel ?? 'Add Layer',
    types: options.types.map((type) => type.name),
  }) as LayersBladeApi
  const controlsHost = folder.addFolder({ title: 'Controls' })

  function findHandle(id: string): LayerHandle | null {
    return records.get(id)?.handle ?? null
  }

  function showOnly(selectedId: string | null): void {
    for (const record of records.values()) {
      record.folder.hidden = record.id !== selectedId
    }
  }

  function addLayer(typeName: string): LayerHandle | null {
    const type = types.get(typeName)
    if (!type) {
      return null
    }

    counter += 1
    const id = `layer-${counter}`
    const name = `${type.name} ${counter}`
    const handle: LayerHandle = {
      id,
      type: type.name,
      name,
      visible: true,
      state: type.createState ? type.createState() : ({} as unknown),
    }

    const layerFolder = controlsHost.addFolder({ title: name, hidden: true })
    // Tweakpane-native rename: editing the name field updates the row label live.
    layerFolder
      .addBinding(handle, 'name', { label: 'name' })
      .on('change', (event) => {
        layerFolder.title = event.value
        blade.setName(id, event.value)
      })
    type.build(layerFolder, handle)

    records.set(id, { id, type: type.name, handle, folder: layerFolder })
    blade.addItem({ id, name, visible: true } satisfies LayerItem)
    blade.select(id)
    showOnly(id)
    options.onAdd?.(handle)
    options.onSelect?.(handle)
    return handle
  }

  blade.on('add', ({ type }) => {
    addLayer(type)
  })

  blade.on('select', ({ id }) => {
    showOnly(id)
    options.onSelect?.(findHandle(id))
  })

  blade.on('visibility', ({ id, visible }) => {
    const record = records.get(id)
    if (!record) {
      return
    }
    record.handle.visible = visible
    blade.setVisible(id, visible)
    options.onVisibility?.(record.handle)
  })

  blade.on('reorder', ({ ids }) => {
    options.onReorder?.(
      ids
        .map((id) => records.get(id)?.handle)
        .filter((handle): handle is LayerHandle => handle != null),
    )
  })

  blade.on('remove', ({ id }) => {
    const record = records.get(id)
    if (!record) {
      return
    }
    record.folder.dispose()
    records.delete(id)
    blade.removeItem(id)

    const next = blade.getItems()[0]?.id ?? null
    if (next) {
      blade.select(next)
      showOnly(next)
      options.onSelect?.(findHandle(next))
    } else {
      showOnly(null)
      options.onSelect?.(null)
    }
    options.onRemove?.(record.handle)
  })

  return {
    addLayer,
    getLayers: () => Array.from(records.values()).map((record) => record.handle),
    blade,
    folder,
  }
}
