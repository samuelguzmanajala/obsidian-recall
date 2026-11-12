import { MarkdownParser, ParsedCard } from '@context/concept/infrastructure/markdown-parser';
import { FrontmatterParser } from '@context/concept/infrastructure/frontmatter-parser';
import { Directionality } from '@context/concept/domain/directionality';
import { Direction } from '@context/study/domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { DeckId } from '@context/deck/domain/deck-id';
import { CardAlias, FileIndex, SourceIndex, SourceLocation } from '../domain/source-index';
import { SimilarityMeter } from '../domain/card-similarity';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { UpdateConcept } from '@context/concept/application/update-concept';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { CreateConcept } from '@context/concept/application/create-concept';
import { RemoveConcept } from '@context/concept/application/remove-concept';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { RemoveStudyItem } from '@context/study/application/remove-study-item';
import { CreateDeck } from '@context/deck/application/create-deck';
import { NestDeck } from '@context/deck/application/nest-deck';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { RemoveStudyItemFromDeck } from '@context/deck/application/remove-study-item-from-deck';

/** Everything the indexer needs; the composition root wires it. */
export interface NoteIndexerDeps {
  parser: Pick<MarkdownParser, 'parse'>;
  /** Persisted index (file → cards, tag → deck). */
  sources: SourceIndex;
  studyItemRepository: Pick<StudyItemRepository, 'findByConceptId'>;
  deckRepository: Pick<DeckRepository, 'findById'>;
  conceptRepository: Pick<ConceptRepository, 'findById'>;
  createConcept: Pick<CreateConcept, 'execute'>;
  updateConcept: Pick<UpdateConcept, 'execute'>;
  removeConcept: Pick<RemoveConcept, 'execute'>;
  createStudyItem: Pick<CreateStudyItem, 'execute'>;
  removeStudyItem: Pick<RemoveStudyItem, 'execute'>;
  createDeck: Pick<CreateDeck, 'execute'>;
  nestDeck: Pick<NestDeck, 'execute'>;
  addStudyItemToDeck: Pick<AddStudyItemToDeck, 'execute'>;
  removeStudyItemFromDeck: Pick<RemoveStudyItemFromDeck, 'execute'>;
  /**
   * Tags to index. Only notes with at least one matching tag (or subtag) are indexed. Empty = all.
   * A function is read on every sync, so the filter can change at runtime (server study settings).
   */
  allowedTags?: readonly string[] | (() => readonly string[]);
}

/** A card as written in a note (or decoded from its key). */
type CardContent = Pick<ParsedCard, 'sideA' | 'sideB' | 'directionality'>;

/**
 * Translates Markdown notes into concept, study item and deck commands, and remembers
 * which cards came from which note. Card, concept and deck IDs are derived from content,
 * except for edited cards, which keep the IDs they inherited (see `inheritEdits`).
 */
export class NoteIndexer {
  private frontmatterParser = new FrontmatterParser();

  private static readonly UNTAGGED_DECK_TAG = '__untagged__';

  constructor(private readonly deps: NoteIndexerDeps) {}

  /** Tags the user configured, as of now. Empty = allow all. */
  private get allowedTags(): readonly string[] {
    const tags = this.deps.allowedTags;
    return typeof tags === 'function' ? tags() : tags ?? [];
  }

  /**
   * Returns only the tags that match the allowed filter.
   * e.g. note has [dev, kafka, German] and allowed is [dev, German]
   * → returns [dev, German] (kafka excluded)
   */
  private filterToAllowedTags(noteTags: string[]): string[] {
    const allowedTags = this.allowedTags;
    if (allowedTags.length === 0) return noteTags;
    return noteTags.filter(noteTag =>
      allowedTags.some(allowed =>
        noteTag === allowed || noteTag.startsWith(allowed + '/'),
      ),
    );
  }

  /**
   * Checks if a note's tags match the allowed filter.
   * A note tag "German/vocabulary" matches allowed tag "German".
   * Empty allowedTags = everything passes.
   */
  private matchesTagFilter(noteTags: string[]): boolean {
    const allowedTags = this.allowedTags;
    if (allowedTags.length === 0) return true;
    return noteTags.some(noteTag =>
      allowedTags.some(allowed =>
        noteTag === allowed || noteTag.startsWith(allowed + '/'),
      ),
    );
  }

  /**
   * Find which file and line a concept belongs to.
   */
  findFileByConceptId(conceptId: string): Promise<SourceLocation | null> {
    return this.deps.sources.locate(conceptId);
  }

  /**
   * Sync a single file. Returns true if the file was indexed (had matching tags + cards).
   */
  async syncFile(filePath: string, content: string): Promise<boolean> {
    const parsedCards = this.deps.parser.parse(content, filePath);
    const tags = this.frontmatterParser.extractTags(content);
    const previousIndex = await this.deps.sources.get(filePath);

    // If tag filter is active and note doesn't match, treat as removal
    if (!this.matchesTagFilter(tags)) {
      if (previousIndex) {
        await this.removeFile(filePath);
      }
      return false;
    }

    if (parsedCards.length === 0) {
      // Matching tags but no cards — remove if previously indexed
      if (previousIndex) {
        await this.removeFile(filePath);
      }
      return false;
    }

    const newIndex: FileIndex = { cardKeys: new Map(), conceptLines: new Map(), studyItemIds: [], deckIds: [] };

    const previousKeys = new Set(previousIndex?.cardKeys.keys() ?? []);

    // Filter tags to only those matching the allowed filter
    // Files without matching tags go to "Untagged" deck
    const filteredTags = this.filterToAllowedTags(tags);
    const effectiveTags = filteredTags.length > 0 ? filteredTags : [NoteIndexer.UNTAGGED_DECK_TAG];
    const leafDeckIds = await this.ensureDeckHierarchy(effectiveTags);
    newIndex.deckIds = leafDeckIds;

    // Detect if deck assignments changed (tags were modified)
    const decksChanged = previousIndex
      ? !this.sameArrays(previousIndex.deckIds, leafDeckIds)
      : false;

    // Edited cards keep their concept, study items and history under the new key
    const edits = previousIndex ? await this.inheritEdits(filePath, previousIndex, parsedCards) : new Map<string, { removedKey: string; conceptId: string }>();
    for (const edit of edits.values()) previousKeys.delete(edit.removedKey);

    for (const card of parsedCards) {
      const key = this.cardKey(card);
      const keptConceptId = previousIndex?.cardKeys.get(key) ?? edits.get(key)?.conceptId;

      if (keptConceptId !== undefined) {
        // Card still exists (possibly edited) — keep it
        const conceptId = keptConceptId;
        newIndex.cardKeys.set(key, conceptId);
        newIndex.conceptLines.set(conceptId, card.lineNumber);
        previousKeys.delete(key);

        // If tags changed, reassign study items to new decks
        if (decksChanged) {
          const studyItems = await this.deps.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );
          const siIds = studyItems.map(si => si.id.value);

          // Remove from old decks
          const retainedDecks = new Set((await this.deps.sources.otherFilesWithConcept(conceptId, filePath))
            .flatMap(file => file.deckIds));
          for (const oldDeckId of previousIndex!.deckIds) {
            if (retainedDecks.has(oldDeckId)) continue;
            for (const siId of siIds) {
              await this.deps.removeStudyItemFromDeck.execute({
                deckId: oldDeckId,
                studyItemId: siId,
              });
            }
          }

          // Add to new decks
          for (const deckId of leafDeckIds) {
            for (const siId of siIds) {
              await this.deps.addStudyItemToDeck.execute({
                deckId,
                studyItemId: siId,
              });
            }
          }

          newIndex.studyItemIds.push(...siIds);
        } else {
          // Decks didn't change — carry over studyItemIds
          const studyItems = await this.deps.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );
          newIndex.studyItemIds.push(...studyItems.map(si => si.id.value));
        }
      } else {
        // New card — create concept + study items + assign to decks
        const { conceptId, studyItemIds } = await this.createConceptWithStudyItems(card, key);
        newIndex.cardKeys.set(key, conceptId);
        newIndex.conceptLines.set(conceptId, card.lineNumber);
        newIndex.studyItemIds.push(...studyItemIds);

        // Assign study items to leaf decks
        for (const deckId of leafDeckIds) {
          for (const siId of studyItemIds) {
            await this.deps.addStudyItemToDeck.execute({
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
      await this.removeConceptWithStudyItems(conceptId, previousIndex!.deckIds, filePath);
    }

    await this.deps.sources.put(filePath, newIndex);
    return true;
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.deps.sources.rename(oldPath, newPath);
  }

  async removeFile(filePath: string): Promise<void> {
    const index = await this.deps.sources.get(filePath);
    if (!index) return;

    for (const conceptId of index.cardKeys.values()) {
      await this.removeConceptWithStudyItems(conceptId, index.deckIds, filePath);
    }

    await this.deps.sources.remove(filePath);
  }

  /**
   * Ensures deck hierarchy exists for tags like "German/grammar".
   * Creates: German (root) → German/grammar (child).
   * Returns leaf deck IDs (the most specific tag).
   */
  private async ensureDeckHierarchy(tags: string[]): Promise<string[]> {
    const leafDeckIds: string[] = [];

    for (const tag of tags) {
      const parts = tag === NoteIndexer.UNTAGGED_DECK_TAG
        ? ['Untagged']
        : tag.split('/');
      let parentId: string | null = null;

      for (let i = 0; i < parts.length; i++) {
        const fullTag = tag === NoteIndexer.UNTAGGED_DECK_TAG
          ? NoteIndexer.UNTAGGED_DECK_TAG
          : parts.slice(0, i + 1).join('/');

        let deckId = await this.deps.sources.deckForTag(fullTag);
        if (!deckId) {
          deckId = await this.computeDeterministicId(`deck:${fullTag}`);
          await this.deps.sources.setDeckForTag(fullTag, deckId);
        }

        const existingDeck = await this.deps.deckRepository.findById(new DeckId(deckId));
        if (!existingDeck) {
          await this.deps.createDeck.execute({
            id: deckId,
            name: parts[i],
            parentId,
          });
        } else if (parentId && existingDeck.parentId?.value !== parentId) {
          await this.deps.nestDeck.execute({
            deckId,
            parentId,
          });
        }

        parentId = deckId;
      }

      // The last segment is the leaf (its full tag is the tag itself)
      leafDeckIds.push(parentId!);
    }

    return leafDeckIds;
  }

  /**
   * Pairs cards removed from this note with cards added to it, conservatively: same
   * directionality and either exactly one side unchanged, or both sides changed but each at
   * least 80% similar (`SimilarityMeter`). Only one-to-one pairs count: a removed card with
   * several candidates, or an added card with several, inherits nothing. A pair is also skipped
   * when the old concept is still used elsewhere, or the new content already has an identity
   * (a live concept or an alias). The concept takes the new sides and keeps its ID, study items
   * and history; the new key gets a durable alias to those IDs.
   * Returns added key → removed key and inherited concept.
   */
  private async inheritEdits(
    filePath: string,
    previousIndex: FileIndex,
    parsedCards: ParsedCard[],
  ): Promise<Map<string, { removedKey: string; conceptId: string }>> {
    const edits = new Map<string, { removedKey: string; conceptId: string }>();
    const current = new Set(parsedCards.map(card => this.cardKey(card)));
    const removed: { key: string; card: CardContent }[] = [];
    for (const key of previousIndex.cardKeys.keys()) {
      const card = current.has(key) ? null : this.parseCardKey(key);
      if (card) removed.push({ key, card });
    }
    const added = new Map<string, ParsedCard>();
    for (const card of parsedCards) {
      const key = this.cardKey(card);
      if (!previousIndex.cardKeys.has(key) && !added.has(key)) added.set(key, card);
    }
    if (!removed.length || !added.size) return edits;

    // Candidate edges; an undecidable comparison (too long, budget spent) blocks without pairing
    const meter = new SimilarityMeter();
    const edges = new Map<string, { addedKey: string; certain: boolean }[]>();
    const degree = new Map<string, number>();
    for (const r of removed) {
      const list: { addedKey: string; certain: boolean }[] = [];
      for (const [addedKey, a] of added) {
        if (a.directionality !== r.card.directionality) continue;
        let certain = true;
        if (a.sideA !== r.card.sideA && a.sideB !== r.card.sideB) {
          const sideA = meter.similar(r.card.sideA, a.sideA);
          if (sideA === false) continue;
          const sideB = meter.similar(r.card.sideB, a.sideB);
          if (sideB === false) continue;
          certain = sideA === true && sideB === true;
        }
        list.push({ addedKey, certain });
        degree.set(addedKey, (degree.get(addedKey) ?? 0) + 1);
      }
      edges.set(r.key, list);
    }

    for (const r of removed) {
      const list = edges.get(r.key)!;
      if (list.length !== 1 || !list[0].certain || degree.get(list[0].addedKey) !== 1) continue;
      const { addedKey } = list[0];
      const card = added.get(addedKey)!;
      const conceptId = previousIndex.cardKeys.get(r.key)!;
      if ([...previousIndex.cardKeys].some(([key, id]) => id === conceptId && key !== r.key)) continue;
      if ((await this.deps.sources.otherFilesWithConcept(conceptId, filePath)).length) continue;
      if (await this.hasIdentity(card, addedKey)) continue;
      if (!(await this.deps.conceptRepository.findById(new ConceptId(conceptId)))) continue;
      const items = await this.deps.studyItemRepository.findByConceptId(new ConceptId(conceptId));
      const aToB = items.find(i => i.direction === Direction.AtoB)?.id.value;
      const bToA = items.find(i => i.direction === Direction.BtoA)?.id.value ?? null;
      const bidirectional = card.directionality === Directionality.Bidirectional;
      if (!aToB || bidirectional !== (bToA !== null)) continue;

      await this.deps.updateConcept.execute({ id: conceptId, sideA: card.sideA, sideB: card.sideB, directionality: card.directionality });
      await this.deps.sources.setAlias(addedKey, { conceptId, aToB, bToA });
      edits.set(addedKey, { removedKey: r.key, conceptId });
    }
    return edits;
  }

  /** Whether this content already has IDs of its own: a card in some note, an alias, or a live hash-derived concept. */
  private async hasIdentity(card: CardContent, key: string): Promise<boolean> {
    if (await this.deps.sources.conceptForCard(key)) return true;
    if (await this.deps.sources.aliasFor(key)) return true;
    const concept = await this.deps.conceptRepository.findById(new ConceptId((await this.candidateIds(card, 0)).conceptId));
    return !!concept && this.holdsContent(concept, card);
  }

  private async createConceptWithStudyItems(
    card: ParsedCard,
    key: string,
  ): Promise<{ conceptId: string; studyItemIds: string[] }> {
    const ids = await this.resolveIds(card, key);
    const { conceptId } = ids;
    const studyItemIds: string[] = [];

    await this.deps.createConcept.execute({
      id: conceptId,
      sideA: card.sideA,
      sideB: card.sideB,
      directionality: card.directionality,
    });

    await this.deps.createStudyItem.execute({
      id: ids.aToB,
      conceptId,
      direction: Direction.AtoB,
    });
    studyItemIds.push(ids.aToB);

    if (card.directionality === Directionality.Bidirectional) {
      await this.deps.createStudyItem.execute({
        id: ids.bToA!,
        conceptId,
        direction: Direction.BtoA,
      });
      studyItemIds.push(ids.bToA!);
    }

    return { conceptId, studyItemIds };
  }

  /**
   * IDs for a card that is new to its note. In order: the alias of its key (an edited card that
   * was removed and comes back, or that another note already uses); otherwise content hashes —
   * the same card always gets the same IDs, so reviews survive rebuilds — salted with `#n` when
   * those IDs belong to different content (a live concept with other sides, or another key's
   * alias, e.g. the pre-edit text of an edited card). A live card with this key whose IDs are
   * not derivable (inconsistent data) is attached to as is.
   */
  private async resolveIds(card: CardContent, key: string): Promise<CardAlias> {
    const live = await this.deps.sources.conceptForCard(key);
    const alias = await this.deps.sources.aliasFor(key);
    if (alias && (alias.conceptId === live || (!live && await this.isFreeFor(alias.conceptId, card)))) return alias;
    for (let n = 0; n < 1000; n++) {
      const ids = await this.candidateIds(card, n);
      if (!(await this.isFreeFor(ids.conceptId, card))) continue;
      const owners = await Promise.all([ids.conceptId, ids.aToB, ids.bToA].map(id => id && this.deps.sources.aliasOwner(id)));
      if (owners.some(owner => owner && owner !== key)) continue;
      if (live && live !== ids.conceptId) {
        const items = await this.deps.studyItemRepository.findByConceptId(new ConceptId(live));
        return {
          conceptId: live,
          aToB: items.find(i => i.direction === Direction.AtoB)?.id.value ?? ids.aToB,
          bToA: ids.bToA && (items.find(i => i.direction === Direction.BtoA)?.id.value ?? ids.bToA),
        };
      }
      return ids;
    }
    throw new Error('No free ID for card');
  }

  /** Content-derived IDs; `n` > 0 salts them (`#n`) to step around IDs taken by other content. */
  private async candidateIds(card: CardContent, n: number): Promise<CardAlias> {
    const salt = n ? `#${n}` : '';
    const base = `${card.sideA}|${card.sideB}`;
    return {
      conceptId: await this.computeDeterministicId(`concept:${base}|${card.directionality}${salt}`),
      aToB: await this.computeDeterministicId(`si:${base}|a-to-b${salt}`),
      bToA: card.directionality === Directionality.Bidirectional
        ? await this.computeDeterministicId(`si:${base}|b-to-a${salt}`)
        : null,
    };
  }

  /** The concept ID is unused or already holds exactly this content. */
  private async isFreeFor(conceptId: string, card: CardContent): Promise<boolean> {
    const concept = await this.deps.conceptRepository.findById(new ConceptId(conceptId));
    return !concept || this.holdsContent(concept, card);
  }

  private holdsContent(concept: { sideA: { content: string }; sideB: { content: string }; directionality: Directionality }, card: CardContent): boolean {
    return concept.sideA.content === card.sideA && concept.sideB.content === card.sideB && concept.directionality === card.directionality;
  }

  /**
   * Generate a deterministic UUID-like ID from a string.
   * Same input always produces the same output.
   * Uses SHA-256 truncated to UUID format.
   */
  async computeDeterministicId(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    // Format as UUID v4-like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private async removeConceptWithStudyItems(
    conceptId: string,
    deckIds: string[],
    excludingPath: string,
  ): Promise<void> {
    const otherSources = await this.deps.sources.otherFilesWithConcept(conceptId, excludingPath);
    const retainedDecks = new Set(otherSources.flatMap(file => file.deckIds));
    const studyItems = await this.deps.studyItemRepository.findByConceptId(
      new ConceptId(conceptId),
    );

    // Remove study items from all associated decks first
    for (const item of studyItems) {
      for (const deckId of deckIds) {
        if (retainedDecks.has(deckId)) continue;
        await this.deps.removeStudyItemFromDeck.execute({
          deckId,
          studyItemId: item.id.value,
        });
      }
      if (otherSources.length === 0) await this.deps.removeStudyItem.execute({ id: item.id.value });
    }

    if (otherSources.length === 0) await this.deps.removeConcept.execute({ id: conceptId });
  }

  /** Stable key based on content. An edit changes the key; `inheritEdits` carries the history over. */
  private cardKey(card: CardContent): string {
    // Use JSON.stringify to avoid collisions when content contains the separator
    return JSON.stringify([card.sideA, card.sideB, card.directionality]);
  }

  /** Inverse of `cardKey`; null for keys in any other shape (they are never paired). */
  private parseCardKey(key: string): CardContent | null {
    try {
      const value: unknown = JSON.parse(key);
      if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'string')) return null;
      const [sideA, sideB, directionality] = value as string[];
      if (!sideA.trim() || !sideB.trim() || !Object.values(Directionality).includes(directionality as Directionality)) return null;
      return { sideA, sideB, directionality: directionality as Directionality };
    } catch {
      return null;
    }
  }

  private sameArrays(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted1 = [...a].sort();
    const sorted2 = [...b].sort();
    return sorted1.every((val, idx) => val === sorted2[idx]);
  }
}
