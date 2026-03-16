import { ConceptId } from './concept-id';
import { Side } from './side';
import { Directionality } from './directionality';

export class Concept {
  private constructor(
    readonly id: ConceptId,
    private _sideA: Side,
    private _sideB: Side,
    private _directionality: Directionality,
  ) {}

  static create(
    id: ConceptId,
    sideA: Side,
    sideB: Side,
    directionality: Directionality,
  ): Concept {
    return new Concept(id, sideA, sideB, directionality);
  }

  get sideA(): Side {
    return this._sideA;
  }

  get sideB(): Side {
    return this._sideB;
  }

  get directionality(): Directionality {
    return this._directionality;
  }

  get isBidirectional(): boolean {
    return this._directionality === Directionality.Bidirectional;
  }

  updateSides(sideA: Side, sideB: Side): void {
    this._sideA = sideA;
    this._sideB = sideB;
  }

  changeDirectionality(directionality: Directionality): void {
    this._directionality = directionality;
  }
}
