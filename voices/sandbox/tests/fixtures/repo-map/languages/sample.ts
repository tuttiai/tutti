export interface Shape {
  area(): number;
}

export type ShapeId = string;

export enum Colour {
  Red,
}

export abstract class BaseShape implements Shape {
  abstract area(): number;
}

export class Square extends BaseShape {
  area(): number {
    return computeArea(2);
  }
}

export function computeArea(side: number): number {
  return side * side;
}

export const makeSquare = (): Square => new Square();

export const DEFAULT_SIDE = 2;

namespace Geometry {}
