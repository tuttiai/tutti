export interface WidgetDefinition {
  widgetName: string;
}

export function registerWidget(definition: WidgetDefinition): void {
  void definition;
}

export function lookupWidget(widgetName: string): WidgetDefinition | undefined {
  return { widgetName };
}
