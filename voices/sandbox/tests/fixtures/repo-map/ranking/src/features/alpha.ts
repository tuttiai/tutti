import { registerWidget, lookupWidget } from "../core/widget-registry.js";
import type { WidgetDefinition } from "../core/widget-registry.js";

export function alphaFeature(): WidgetDefinition | undefined {
  registerWidget({ widgetName: "alpha" });
  return lookupWidget("alpha");
}
