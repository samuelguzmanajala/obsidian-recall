import { DeckRepository } from '../domain/deck-repository';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckId } from '../domain/deck-id';

export interface DeckTreeNode {
  id: string;
  name: string;
  totalItems: number;
  dueItems: number;
  newItems: number;
  children: DeckTreeNode[];
}

interface BuildResult {
  node: DeckTreeNode;
  subtreeIds: Set<string>;
}

export class GetDeckTree {
  constructor(
    private readonly deckRepository: DeckRepository,
    private readonly studyItemRepository: StudyItemRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<DeckTreeNode[]> {
    const roots = await this.deckRepository.findRoots();
    const allItems = await this.studyItemRepository.findAll();
    const dueIds = new Set(
      allItems.filter(item => item.memoryState.due <= now).map(item => item.id.value),
    );
    const newIds = new Set(
      allItems.filter(item => item.memoryState.reps === 0).map(item => item.id.value),
    );

    const nodes: DeckTreeNode[] = [];
    for (const root of roots) {
      const result = await this.buildNode(
        root.id,
        root.name,
        root.studyItemIds.map(si => si.value),
        dueIds,
        newIds,
      );
      nodes.push(result.node);
    }
    return nodes;
  }

  private async buildNode(
    deckId: DeckId,
    name: string,
    directIds: string[],
    dueIds: Set<string>,
    newIds: Set<string>,
  ): Promise<BuildResult> {
    const children = await this.deckRepository.findByParentId(deckId);
    const childNodes: DeckTreeNode[] = [];
    const subtreeIds = new Set(directIds);

    for (const child of children) {
      const childResult = await this.buildNode(
        child.id,
        child.name,
        child.studyItemIds.map(si => si.value),
        dueIds,
        newIds,
      );
      childNodes.push(childResult.node);
      for (const id of childResult.subtreeIds) {
        subtreeIds.add(id);
      }
    }

    const subtreeArray = [...subtreeIds];

    return {
      node: {
        id: deckId.value,
        name,
        totalItems: subtreeIds.size,
        dueItems: subtreeArray.filter(id => dueIds.has(id)).length,
        newItems: subtreeArray.filter(id => newIds.has(id)).length,
        children: childNodes,
      },
      subtreeIds,
    };
  }
}
