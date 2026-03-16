import { Container } from './container';
import { ParsedCard } from '@context/concept/infrastructure/markdown-parser';
import { FrontmatterParser } from '@context/concept/infrastructure/frontmatter-parser';
import { Directionality } from '@context/concept/domain/directionality';
import { Direction } from '@context/study/domain/direction';
import { DeckId } from '@context/deck/domain/deck-id';

/**
 * Tracks which concepts came from which file, so we can
 * detect additions, removals, and changes when a file is re-parsed.
 */
interface FileIndex {
  /** Map of "sideA|sideB|directionality" → conceptId */
  cardKeys: Map<string, string>;
  /** studyItemIds created for this file */
  studyItemIds: string[];
  /** deckIds (leaf decks) assigned to this file's cards */
  deckIds: string[];
}

export class VaultSync {
  private fileIndices = new Map<string, FileIndex>();
  private frontmatterParser = new FrontmatterParser();
  /** tag → deckId — ensures same tag always maps to same deck */
  private tagToDeckId = new Map<string, string>();

  constructor(private readonly container: Container) {}

  async syncFile(filePath: string, content: string): Promise<void> {
    const parsedCards = this.container.parser.parse(content, filePath);
    const tags = this.frontmatterParser.extractTags(content);
    const previousIndex = this.fileIndices.get(filePath);
    const newIndex: FileIndex = { cardKeys: new Map(), studyItemIds: [], deckIds: [] };

    const previousKeys = new Set(previousIndex?.cardKeys.keys() ?? []);

    // Ensure deck hierarchy exists for all tags
    const leafDeckIds = await this.ensureDeckHierarchy(tags);
    newIndex.deckIds = leafDeckIds;

    for (const card of parsedCards) {
      const key = this.cardKey(card);

      if (previousIndex?.cardKeys.has(key)) {
        // Card still exists — keep it
        const conceptId = previousIndex.cardKeys.get(key)!;
        newIndex.cardKeys.set(key, conceptId);
        previousKeys.delete(key);
      } else {
        // New card — create concept + study items + assign to decks
        const { conceptId, studyItemIds } = await this.createConceptWithStudyItems(card);
        newIndex.cardKeys.set(key, conceptId);
        newIndex.studyItemIds.push(...studyItemIds);

        // Assign study items to leaf decks
        for (const deckId of leafDeckIds) {
          for (const siId of studyItemIds) {
            await this.container.addStudyItemToDeck.execute({
              deckId,
              studyItemId: siId,
            });
          }
        }
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

  /**
   * Ensures deck hierarchy exists for tags like "German/grammar".
   * Creates: German (root) → German/grammar (child).
   * Returns leaf deck IDs (the most specific tag).
   */
  private async ensureDeckHierarchy(tags: string[]): Promise<string[]> {
    const leafDeckIds: string[] = [];

    for (const tag of tags) {
      const parts = tag.split('/');
      let parentId: string | null = null;

      for (let i = 0; i < parts.length; i++) {
        const fullTag = parts.slice(0, i + 1).join('/');

        if (!this.tagToDeckId.has(fullTag)) {
          const deckId = crypto.randomUUID();
          this.tagToDeckId.set(fullTag, deckId);

          await this.container.createDeck.execute({
            id: deckId,
            name: parts[i],
          });

          if (parentId) {
            await this.container.nestDeck.execute({
              deckId,
              parentId,
            });
          }
        }

        parentId = this.tagToDeckId.get(fullTag)!;
      }

      // The last segment is the leaf
      leafDeckIds.push(this.tagToDeckId.get(tag)!);
    }

    return leafDeckIds;
  }

  private async createConceptWithStudyItems(
    card: ParsedCard,
  ): Promise<{ conceptId: string; studyItemIds: string[] }> {
    const conceptId = crypto.randomUUID();
    const studyItemIds: string[] = [];

    await this.container.createConcept.execute({
      id: conceptId,
      sideA: card.sideA,
      sideB: card.sideB,
      directionality: card.directionality,
    });

    const atobId = crypto.randomUUID();
    await this.container.createStudyItem.execute({
      id: atobId,
      conceptId,
      direction: Direction.AtoB,
    });
    studyItemIds.push(atobId);

    if (card.directionality === Directionality.Bidirectional) {
      const btoaId = crypto.randomUUID();
      await this.container.createStudyItem.execute({
        id: btoaId,
        conceptId,
        direction: Direction.BtoA,
      });
      studyItemIds.push(btoaId);
    }

    return { conceptId, studyItemIds };
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
