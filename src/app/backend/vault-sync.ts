import { Container } from './container';
import { ParsedCard } from '@context/concept/infrastructure/markdown-parser';
import { Directionality } from '@context/concept/domain/directionality';
import { Direction } from '@context/study/domain/direction';

/**
 * Tracks which concepts came from which file+line, so we can
 * detect additions, removals, and changes when a file is re-parsed.
 */
interface FileIndex {
  /** Map of "sideA|sideB|directionality" → conceptId */
  cardKeys: Map<string, string>;
}

export class VaultSync {
  /** filePath → FileIndex */
  private fileIndices = new Map<string, FileIndex>();

  constructor(private readonly container: Container) {}

  async syncFile(filePath: string, content: string): Promise<void> {
    const parsedCards = this.container.parser.parse(content, filePath);
    const previousIndex = this.fileIndices.get(filePath);
    const newIndex: FileIndex = { cardKeys: new Map() };

    const previousKeys = new Set(previousIndex?.cardKeys.keys() ?? []);

    for (const card of parsedCards) {
      const key = this.cardKey(card);

      if (previousIndex?.cardKeys.has(key)) {
        // Card still exists — keep it
        newIndex.cardKeys.set(key, previousIndex.cardKeys.get(key)!);
        previousKeys.delete(key);
      } else {
        // New card — create concept + study items
        const conceptId = await this.createConceptWithStudyItems(card);
        newIndex.cardKeys.set(key, conceptId);
      }
    }

    // Remove cards that no longer exist in the file
    for (const removedKey of previousKeys) {
      const conceptId = previousIndex!.cardKeys.get(removedKey)!;
      await this.removeConceptWithStudyItems(conceptId);
    }

    this.fileIndices.set(filePath, newIndex);
  }

  async removeFile(filePath: string): Promise<void> {
    const index = this.fileIndices.get(filePath);
    if (!index) return;

    for (const conceptId of index.cardKeys.values()) {
      await this.removeConceptWithStudyItems(conceptId);
    }

    this.fileIndices.delete(filePath);
  }

  private async createConceptWithStudyItems(card: ParsedCard): Promise<string> {
    const conceptId = crypto.randomUUID();

    await this.container.createConcept.execute({
      id: conceptId,
      sideA: card.sideA,
      sideB: card.sideB,
      directionality: card.directionality,
    });

    // Always create A→B study item
    await this.container.createStudyItem.execute({
      id: crypto.randomUUID(),
      conceptId,
      direction: Direction.AtoB,
    });

    // Create B→A only for bidirectional
    if (card.directionality === Directionality.Bidirectional) {
      await this.container.createStudyItem.execute({
        id: crypto.randomUUID(),
        conceptId,
        direction: Direction.BtoA,
      });
    }

    return conceptId;
  }

  private async removeConceptWithStudyItems(conceptId: string): Promise<void> {
    const { ConceptId } = await import('@context/concept/domain/concept-id');
    const studyItems = await this.container.studyItemRepository.findByConceptId(
      new ConceptId(conceptId),
    );

    for (const item of studyItems) {
      await this.container.removeStudyItem.execute({ id: item.id.value });
    }

    await this.container.removeConcept.execute({ id: conceptId });
  }

  private cardKey(card: ParsedCard): string {
    return `${card.sideA}|${card.sideB}|${card.directionality}`;
  }
}
