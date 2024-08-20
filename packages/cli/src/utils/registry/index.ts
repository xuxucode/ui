import path from "path"
import { Config } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import {
  registryBaseColorSchema,
  registryIndexSchema,
  registryItemFileSchema,
  registryItemSchema,
  registryResolvedItemsTreeSchema,
  stylesSchema,
} from "@/src/utils/registry/schema"
import { buildTailwindThemeColorsFromCssVars } from "@/src/utils/updaters/update-tailwind-config"
import deepmerge from "deepmerge"
import { HttpsProxyAgent } from "https-proxy-agent"
import { cyan } from "kleur/colors"
import fetch from "node-fetch"
import { z } from "zod"

const REGISTRY_BASE_URL =
  process.env.COMPONENTS_REGISTRY_URL ?? "https://ui.shadcn.com"

const agent = process.env.https_proxy
  ? new HttpsProxyAgent(process.env.https_proxy)
  : undefined

export async function getRegistryIndex() {
  try {
    const [result] = await fetchRegistry(["index.json"])

    return registryIndexSchema.parse(result)
  } catch (error) {
    logger.error("\n")
    handleError(error)
  }
}

export async function getRegistryStyles() {
  try {
    const [result] = await fetchRegistry(["styles/index.json"])

    return stylesSchema.parse(result)
  } catch (error) {
    logger.error("\n")
    handleError(error)
    return []
  }
}

export async function getRegistryItem(style: string, name: string) {
  try {
    const [result] = await fetchRegistry([`styles/${style}/${name}.json`])

    return registryItemSchema.parse(result)
  } catch (error) {
    logger.error("\n")
    handleError(error)

    return null
  }
}

export async function getRegistryBaseColors() {
  return [
    {
      name: "neutral",
      label: "Neutral",
    },
    {
      name: "gray",
      label: "Gray",
    },
    {
      name: "zinc",
      label: "Zinc",
    },
    {
      name: "stone",
      label: "Stone",
    },
    {
      name: "slate",
      label: "Slate",
    },
  ]
}

export async function getRegistryBaseColor(baseColor: string) {
  try {
    const [result] = await fetchRegistry([`colors/${baseColor}.json`])

    return registryBaseColorSchema.parse(result)
  } catch (error) {
    handleError(error)
  }
}

export async function resolveTree(
  index: z.infer<typeof registryIndexSchema>,
  names: string[]
) {
  const tree: z.infer<typeof registryIndexSchema> = []

  for (const name of names) {
    const entry = index.find((entry) => entry.name === name)

    if (!entry) {
      continue
    }

    tree.push(entry)

    if (entry.registryDependencies) {
      const dependencies = await resolveTree(index, entry.registryDependencies)
      tree.push(...dependencies)
    }
  }

  return tree.filter(
    (component, index, self) =>
      self.findIndex((c) => c.name === component.name) === index
  )
}

export async function fetchTree(
  style: string,
  tree: z.infer<typeof registryIndexSchema>
) {
  try {
    const paths = tree.map((item) => `styles/${style}/${item.name}.json`)
    const result = await fetchRegistry(paths)
    return registryIndexSchema.parse(result)
  } catch (error) {
    handleError(error)
  }
}

export async function getItemTargetPath(
  config: Config,
  item: z.infer<typeof registryItemSchema>,
  override?: string
) {
  if (override) {
    return override
  }

  if (item.type === "registry:ui" && config.aliases.ui) {
    return config.resolvedPaths.ui
  }

  const [parent, type] = item.type?.split(":") ?? []
  if (!(parent in config.resolvedPaths)) {
    return null
  }

  return path.join(
    config.resolvedPaths[parent as keyof typeof config.resolvedPaths],
    type
  )
}

async function fetchRegistry(paths: string[]) {
  try {
    const results = await Promise.all(
      paths.map(async (path) => {
        const url = `${REGISTRY_BASE_URL}/registry/${path}`
        const response = await fetch(url, { agent })

        if (!response.ok) {
          const errorMessages: { [key: number]: string } = {
            404: "Not found",
            401: "Unauthorized",
            403: "Forbidden",
            500: "Internal server error",
          }
          const message = errorMessages[response.status] || response.statusText
          throw new Error(`Failed to fetch from ${cyan(url)}. ${message}`)
        }

        return response.json()
      })
    )

    return results
  } catch (error) {
    logger.error("\n")
    handleError(error)
    return []
  }
}

export function getRegistryItemFileTargetPath(
  file: z.infer<typeof registryItemFileSchema>,
  config: Config,
  override?: string
) {
  if (override) {
    return override
  }

  if (file.type === "registry:ui") {
    return config.resolvedPaths.ui
  }

  if (file.type === "registry:lib") {
    return config.resolvedPaths.lib
  }

  if (file.type === "registry:block") {
    return config.resolvedPaths.components
  }

  if (file.type === "registry:hook") {
    return config.resolvedPaths.hooks
  }

  return config.resolvedPaths.components
}

export async function registryResolveItemsTree(
  names: z.infer<typeof registryItemSchema>["name"][],
  config: Config
) {
  const index = await getRegistryIndex()
  if (!index) {
    return null
  }

  let items = (
    await Promise.all(
      names.map(async (name) => {
        const item = await getRegistryItem(config.style, name)
        return item
      })
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null)

  if (!items.length) {
    return null
  }

  const registryDependencies: string[] = items
    .map((item) => item.registryDependencies ?? [])
    .flat()

  const uniqueDependencies = Array.from(new Set(registryDependencies))
  const tree = await resolveTree(index, [...names, ...uniqueDependencies])
  let payload = await fetchTree(config.style, tree)

  if (!payload) {
    return null
  }

  // Add the index item to the beginning of the payload.
  if (names.includes("index")) {
    const index = await getRegistryItem(config.style, "index")
    if (index) {
      payload.unshift(index)
    }
  }

  // Fetch the theme item if a base color is provided.
  if (config.tailwind.baseColor) {
    const theme = await registryGetTheme(config.tailwind.baseColor, config)
    if (theme) {
      payload.unshift(theme)
    }
  }

  let tailwind = {}
  payload.forEach((item) => {
    tailwind = deepmerge(tailwind, item.tailwind ?? {})
  })

  let cssVars = {}
  payload.forEach((item) => {
    cssVars = deepmerge(cssVars, item.cssVars ?? {})
  })

  return registryResolvedItemsTreeSchema.parse({
    dependencies: deepmerge.all(payload.map((item) => item.dependencies ?? [])),
    devDependencies: deepmerge.all(
      payload.map((item) => item.devDependencies ?? [])
    ),
    files: deepmerge.all(payload.map((item) => item.files ?? [])),
    tailwind,
    cssVars,
  })
}

export async function registryGetTheme(name: string, config: Config) {
  const baseColor = await getRegistryBaseColor(name)
  if (!baseColor) {
    return null
  }

  const theme = {
    name,
    type: "registry:theme",
    tailwind: {
      config: {
        theme: {
          extend: {
            borderRadius: {
              lg: "var(--radius)",
              md: "calc(var(--radius) - 2px)",
              sm: "calc(var(--radius) - 4px)",
            },
            colors: {},
          },
        },
      },
    },
    cssVars: {
      light: {
        radius: "0.5rem",
      },
      dark: {},
    },
  } satisfies z.infer<typeof registryItemSchema>

  if (config.tailwind.cssVariables) {
    theme.tailwind.config.theme.extend.colors = {
      ...theme.tailwind.config.theme.extend.colors,
      ...buildTailwindThemeColorsFromCssVars(baseColor.cssVars.dark),
    }
    theme.cssVars = {
      light: {
        ...baseColor.cssVars.light,
        ...theme.cssVars.light,
      },
      dark: {
        ...baseColor.cssVars.dark,
        ...theme.cssVars.dark,
      },
    }
  }

  return theme
}
