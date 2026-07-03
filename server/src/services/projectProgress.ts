import { prisma } from '../lib/prisma';
import {
  CalcEntry,
  CalcItem,
  computeItem,
  computeCategories,
  computeOverall,
  assessDelay,
  ItemProgress,
  CategoryProgress,
  OverallProgress,
  DelayRisk,
} from './calc';

export interface ProjectProgress {
  items: ItemProgress[];
  itemsById: Map<string, ItemProgress>;
  categories: CategoryProgress[];
  overall: OverallProgress;
  risk: DelayRisk;
  targetCompletionDate: Date | null;
}

// Load all BOQ items + approved entries for a project and run the full calc
// engine. Single source of truth used by dashboard, projects list and reports.
export async function loadProjectProgress(projectId: string, now = new Date()): Promise<ProjectProgress> {
  const [project, boqItems, entries] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { targetCompletionDate: true } }),
    prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.progressEntry.findMany({
      where: { projectId, status: 'APPROVED' },
      select: { boqItemId: true, date: true, quantityInstalled: true, status: true },
    }),
  ]);

  const calcEntries: CalcEntry[] = entries.map((e) => ({
    boqItemId: e.boqItemId,
    date: e.date,
    quantityInstalled: e.quantityInstalled,
    status: e.status,
  }));

  const calcItems: CalcItem[] = boqItems.map((b) => ({
    id: b.id,
    description: b.description,
    category: b.category,
    roomZone: b.roomZone,
    unit: b.unit,
    plannedQty: b.plannedQty,
    isGroup: b.isGroup,
    zoneId: b.zoneId,
  }));

  const items = calcItems.map((it) => computeItem(it, calcEntries, now));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const categories = computeCategories(items);
  const overall = computeOverall(items);
  const target = project?.targetCompletionDate ?? null;
  const risk = assessDelay(overall.estimatedCompletionDate, target, now);

  return { items, itemsById, categories, overall, risk, targetCompletionDate: target };
}
