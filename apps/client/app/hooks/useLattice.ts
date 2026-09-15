/**
 * useLattice - Zustand Store for Lattice Financial Models
 *
 * Manages client-side state for Lattice models including:
 * - Data layer (entities, relationships)
 * - Rules layer (formulas, constraints)
 * - View layer (presentation configs)
 * - Computed values (hydration results)
 * - Operations history (undo/redo)
 */

import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';

import type {
  ILatticeModel,
  ILatticeEntity,
  ILatticeRule,
  ILatticeView,
  ILatticeScenario,
  ILatticeComputedValues,
  ILatticeOperation,
  ILatticeModelSettings,
  PrimitiveValue,
  LatticeOperationType,
} from '@bike4mind/common';

// TYPES

interface LatticeState {
  // Current model
  model: ILatticeModel | null;
  modelId: string | null;

  // Computed values from hydration
  computedValues: ILatticeComputedValues;
  isComputing: boolean;
  lastComputedAt: Date | null;

  // UI state
  activeViewId: string | null;
  activeScenarioId: string | null;
  selectedEntityId: string | null;
  selectedRuleId: string | null;
  showFormulas: boolean;
  explainMode: boolean;

  // Operations
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;

  // Errors
  errors: string[];
}

interface LatticeActions {
  // Model lifecycle
  createModel: (name: string, modelType?: ILatticeModel['modelType']) => void;
  loadModel: (model: ILatticeModel) => void;
  clearModel: () => void;
  updateModelSettings: (settings: Partial<ILatticeModelSettings>) => void;

  // Entity operations
  addEntity: (entity: Omit<ILatticeEntity, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateEntity: (entityId: string, updates: Partial<ILatticeEntity>) => void;
  deleteEntity: (entityId: string) => void;
  setEntityValue: (entityId: string, attributeKey: string, value: PrimitiveValue) => void;

  // Rule operations
  addRule: (rule: Omit<ILatticeRule, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateRule: (ruleId: string, updates: Partial<ILatticeRule>) => void;
  deleteRule: (ruleId: string) => void;
  toggleRule: (ruleId: string) => void;

  // View operations
  addView: (view: Omit<ILatticeView, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateView: (viewId: string, updates: Partial<ILatticeView>) => void;
  deleteView: (viewId: string) => void;
  setActiveView: (viewId: string | null) => void;

  // Scenario operations
  addScenario: (name: string, description?: string) => string;
  updateScenario: (scenarioId: string, updates: Partial<ILatticeScenario>) => void;
  deleteScenario: (scenarioId: string) => void;
  setActiveScenario: (scenarioId: string | null) => void;
  setScenarioOverride: (scenarioId: string, entityId: string, attrKey: string, value: PrimitiveValue) => void;

  // Computation
  setComputedValues: (values: ILatticeComputedValues) => void;
  setIsComputing: (computing: boolean) => void;

  // History
  undo: () => void;
  redo: () => void;

  // UI state
  setSelectedEntity: (entityId: string | null) => void;
  setSelectedRule: (ruleId: string | null) => void;
  setShowFormulas: (show: boolean) => void;
  setExplainMode: (enabled: boolean) => void;

  // Errors
  addError: (error: string) => void;
  clearErrors: () => void;

  // Export model for persistence
  exportModel: () => ILatticeModel | null;
}

type LatticeStore = LatticeState & LatticeActions;

// HELPERS

const createEmptyModel = (name: string, modelType: ILatticeModel['modelType'] = 'custom'): ILatticeModel => ({
  id: uuidv4(),
  name,
  modelType,
  userId: '', // Will be set on server
  data: { entities: [], relationships: [] },
  rules: { rules: [], rulesets: [] },
  views: { views: [] },
  settings: {
    currency: 'USD',
    fiscalYearStart: '01-01',
    periodGrain: 'quarter',
    defaultDecimalPlaces: 2,
    negativeFormat: 'parentheses',
  },
  scenarios: [],
  operations: [],
  operationIndex: -1,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const createOperation = (
  type: LatticeOperationType,
  data: Record<string, unknown>,
  inverse: Record<string, unknown>,
  description: string
): ILatticeOperation => ({
  id: uuidv4(),
  type,
  timestamp: new Date(),
  data,
  inverse,
  description,
});

// STORE

export const useLattice = create<LatticeStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        // Initial state
        model: null,
        modelId: null,
        computedValues: {},
        isComputing: false,
        lastComputedAt: null,
        activeViewId: null,
        activeScenarioId: null,
        selectedEntityId: null,
        selectedRuleId: null,
        showFormulas: false,
        explainMode: false,
        canUndo: false,
        canRedo: false,
        isDirty: false,
        errors: [],

        // Model lifecycle
        createModel: (name, modelType = 'custom') => {
          const model = createEmptyModel(name, modelType);
          set({
            model,
            modelId: model.id,
            computedValues: {},
            isComputing: false,
            lastComputedAt: null,
            activeViewId: null,
            activeScenarioId: null,
            selectedEntityId: null,
            selectedRuleId: null,
            canUndo: false,
            canRedo: false,
            isDirty: false,
            errors: [],
          });
        },

        loadModel: model => {
          set({
            model: { ...model },
            modelId: model.id,
            computedValues: {},
            isComputing: false,
            lastComputedAt: null,
            activeViewId: model.views.activeViewId || null,
            activeScenarioId: model.activeScenarioId || null,
            selectedEntityId: null,
            selectedRuleId: null,
            canUndo: model.operationIndex >= 0,
            canRedo: model.operationIndex < model.operations.length - 1,
            isDirty: false,
            errors: [],
          });
        },

        clearModel: () => {
          set({
            model: null,
            modelId: null,
            computedValues: {},
            isComputing: false,
            lastComputedAt: null,
            activeViewId: null,
            activeScenarioId: null,
            selectedEntityId: null,
            selectedRuleId: null,
            canUndo: false,
            canRedo: false,
            isDirty: false,
            errors: [],
          });
        },

        updateModelSettings: settings => {
          const { model } = get();
          if (!model) return;

          const oldSettings = { ...model.settings };
          const newSettings = { ...model.settings, ...settings };

          const op = createOperation(
            'UPDATE_SETTINGS',
            { settings: newSettings },
            { settings: oldSettings },
            'Update model settings'
          );

          set({
            model: {
              ...model,
              settings: newSettings,
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        // Entity operations
        addEntity: entityData => {
          const { model } = get();
          if (!model) return '';

          const entity: ILatticeEntity = {
            ...entityData,
            id: uuidv4(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const op = createOperation(
            'CREATE_ENTITY',
            { entity },
            { entityId: entity.id },
            `Create entity "${entity.name}"`
          );

          set({
            model: {
              ...model,
              data: {
                ...model.data,
                entities: [...model.data.entities, entity],
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });

          return entity.id;
        },

        updateEntity: (entityId, updates) => {
          const { model } = get();
          if (!model) return;

          const entityIndex = model.data.entities.findIndex(e => e.id === entityId);
          if (entityIndex === -1) return;

          const oldEntity = model.data.entities[entityIndex];
          const newEntity: ILatticeEntity = {
            ...oldEntity,
            ...updates,
            updatedAt: new Date(),
          };

          const op = createOperation(
            'UPDATE_ENTITY',
            { entity: newEntity },
            { entity: oldEntity },
            `Update entity "${oldEntity.name}"`
          );

          const newEntities = [...model.data.entities];
          newEntities[entityIndex] = newEntity;

          set({
            model: {
              ...model,
              data: { ...model.data, entities: newEntities },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        deleteEntity: entityId => {
          const { model } = get();
          if (!model) return;

          const entity = model.data.entities.find(e => e.id === entityId);
          if (!entity) return;

          const op = createOperation('DELETE_ENTITY', { entityId }, { entity }, `Delete entity "${entity.name}"`);

          set({
            model: {
              ...model,
              data: {
                ...model.data,
                entities: model.data.entities.filter(e => e.id !== entityId),
                relationships: model.data.relationships.filter(
                  r => r.fromEntityId !== entityId && r.toEntityId !== entityId
                ),
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            selectedEntityId: get().selectedEntityId === entityId ? null : get().selectedEntityId,
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        setEntityValue: (entityId, attributeKey, value) => {
          const { model } = get();
          if (!model) return;

          const entityIndex = model.data.entities.findIndex(e => e.id === entityId);
          if (entityIndex === -1) return;

          const entity = model.data.entities[entityIndex];
          const attrIndex = entity.attributes.findIndex(a => a.key === attributeKey);

          let oldValue: PrimitiveValue = null;
          const newAttributes = [...entity.attributes];

          if (attrIndex >= 0) {
            oldValue = entity.attributes[attrIndex].value;
            newAttributes[attrIndex] = {
              ...entity.attributes[attrIndex],
              value,
            };
          } else {
            // Create new attribute
            newAttributes.push({
              key: attributeKey,
              value,
              dataType: typeof value === 'number' ? 'number' : 'string',
              isComputed: false,
            });
          }

          const op = createOperation(
            'SET_VALUE',
            { entityId, attributeKey, value },
            { entityId, attributeKey, value: oldValue },
            `Set ${entity.name}.${attributeKey} = ${value}`
          );

          const newEntities = [...model.data.entities];
          newEntities[entityIndex] = {
            ...entity,
            attributes: newAttributes,
            updatedAt: new Date(),
          };

          set({
            model: {
              ...model,
              data: { ...model.data, entities: newEntities },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        // Rule operations
        addRule: ruleData => {
          const { model } = get();
          if (!model) return '';

          const rule: ILatticeRule = {
            ...ruleData,
            id: uuidv4(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const op = createOperation('CREATE_RULE', { rule }, { ruleId: rule.id }, `Create rule "${rule.name}"`);

          set({
            model: {
              ...model,
              rules: {
                ...model.rules,
                rules: [...model.rules.rules, rule],
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });

          return rule.id;
        },

        updateRule: (ruleId, updates) => {
          const { model } = get();
          if (!model) return;

          const ruleIndex = model.rules.rules.findIndex(r => r.id === ruleId);
          if (ruleIndex === -1) return;

          const oldRule = model.rules.rules[ruleIndex];
          const newRule: ILatticeRule = {
            ...oldRule,
            ...updates,
            updatedAt: new Date(),
          };

          const op = createOperation(
            'UPDATE_RULE',
            { rule: newRule },
            { rule: oldRule },
            `Update rule "${oldRule.name}"`
          );

          const newRules = [...model.rules.rules];
          newRules[ruleIndex] = newRule;

          set({
            model: {
              ...model,
              rules: { ...model.rules, rules: newRules },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        deleteRule: ruleId => {
          const { model } = get();
          if (!model) return;

          const rule = model.rules.rules.find(r => r.id === ruleId);
          if (!rule) return;

          const op = createOperation('DELETE_RULE', { ruleId }, { rule }, `Delete rule "${rule.name}"`);

          set({
            model: {
              ...model,
              rules: {
                ...model.rules,
                rules: model.rules.rules.filter(r => r.id !== ruleId),
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            selectedRuleId: get().selectedRuleId === ruleId ? null : get().selectedRuleId,
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        toggleRule: ruleId => {
          const { model } = get();
          if (!model) return;

          const rule = model.rules.rules.find(r => r.id === ruleId);
          if (!rule) return;

          get().updateRule(ruleId, { enabled: !rule.enabled });
        },

        // View operations
        addView: viewData => {
          const { model } = get();
          if (!model) return '';

          const view: ILatticeView = {
            ...viewData,
            id: uuidv4(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const op = createOperation('CREATE_VIEW', { view }, { viewId: view.id }, `Create view "${view.name}"`);

          set({
            model: {
              ...model,
              views: {
                ...model.views,
                views: [...model.views.views, view],
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });

          return view.id;
        },

        updateView: (viewId, updates) => {
          const { model } = get();
          if (!model) return;

          const viewIndex = model.views.views.findIndex(v => v.id === viewId);
          if (viewIndex === -1) return;

          const oldView = model.views.views[viewIndex];
          const newView: ILatticeView = {
            ...oldView,
            ...updates,
            updatedAt: new Date(),
          };

          const op = createOperation(
            'UPDATE_VIEW',
            { view: newView },
            { view: oldView },
            `Update view "${oldView.name}"`
          );

          const newViews = [...model.views.views];
          newViews[viewIndex] = newView;

          set({
            model: {
              ...model,
              views: { ...model.views, views: newViews },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        deleteView: viewId => {
          const { model } = get();
          if (!model) return;

          const view = model.views.views.find(v => v.id === viewId);
          if (!view) return;

          const op = createOperation('DELETE_VIEW', { viewId }, { view }, `Delete view "${view.name}"`);

          set({
            model: {
              ...model,
              views: {
                ...model.views,
                views: model.views.views.filter(v => v.id !== viewId),
              },
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            activeViewId: get().activeViewId === viewId ? null : get().activeViewId,
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        setActiveView: viewId => {
          set({ activeViewId: viewId });
        },

        // Scenario operations
        addScenario: (name, description) => {
          const { model } = get();
          if (!model) return '';

          const scenario: ILatticeScenario = {
            id: uuidv4(),
            name,
            description,
            overrides: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const op = createOperation(
            'CREATE_SCENARIO',
            { scenario },
            { scenarioId: scenario.id },
            `Create scenario "${name}"`
          );

          set({
            model: {
              ...model,
              scenarios: [...model.scenarios, scenario],
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });

          return scenario.id;
        },

        updateScenario: (scenarioId, updates) => {
          const { model } = get();
          if (!model) return;

          const scenarioIndex = model.scenarios.findIndex(s => s.id === scenarioId);
          if (scenarioIndex === -1) return;

          const oldScenario = model.scenarios[scenarioIndex];
          const newScenario: ILatticeScenario = {
            ...oldScenario,
            ...updates,
            updatedAt: new Date(),
          };

          const op = createOperation(
            'UPDATE_SCENARIO',
            { scenario: newScenario },
            { scenario: oldScenario },
            `Update scenario "${oldScenario.name}"`
          );

          const newScenarios = [...model.scenarios];
          newScenarios[scenarioIndex] = newScenario;

          set({
            model: {
              ...model,
              scenarios: newScenarios,
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        deleteScenario: scenarioId => {
          const { model } = get();
          if (!model) return;

          const scenario = model.scenarios.find(s => s.id === scenarioId);
          if (!scenario) return;

          const op = createOperation(
            'DELETE_SCENARIO',
            { scenarioId },
            { scenario },
            `Delete scenario "${scenario.name}"`
          );

          set({
            model: {
              ...model,
              scenarios: model.scenarios.filter(s => s.id !== scenarioId),
              operations: [...model.operations.slice(0, model.operationIndex + 1), op],
              operationIndex: model.operationIndex + 1,
              updatedAt: new Date(),
            },
            activeScenarioId: get().activeScenarioId === scenarioId ? null : get().activeScenarioId,
            canUndo: true,
            canRedo: false,
            isDirty: true,
          });
        },

        setActiveScenario: scenarioId => {
          set({ activeScenarioId: scenarioId });
        },

        setScenarioOverride: (scenarioId, entityId, attrKey, value) => {
          const { model } = get();
          if (!model) return;

          const scenario = model.scenarios.find(s => s.id === scenarioId);
          if (!scenario) return;

          const overrideIndex = scenario.overrides.findIndex(
            o => o.entityId === entityId && o.attributeKey === attrKey
          );

          const newOverrides = [...scenario.overrides];
          if (overrideIndex >= 0) {
            newOverrides[overrideIndex] = { entityId, attributeKey: attrKey, value };
          } else {
            newOverrides.push({ entityId, attributeKey: attrKey, value });
          }

          get().updateScenario(scenarioId, { overrides: newOverrides });
        },

        // Computation
        setComputedValues: values => {
          set({
            computedValues: values,
            lastComputedAt: new Date(),
          });
        },

        setIsComputing: computing => {
          set({ isComputing: computing });
        },

        // History (simplified undo/redo - full implementation would replay operations)
        undo: () => {
          const { model } = get();
          if (!model || model.operationIndex < 0) return;

          set({
            model: {
              ...model,
              operationIndex: model.operationIndex - 1,
            },
            canUndo: model.operationIndex > 0,
            canRedo: true,
            isDirty: true,
          });
        },

        redo: () => {
          const { model } = get();
          if (!model || model.operationIndex >= model.operations.length - 1) return;

          set({
            model: {
              ...model,
              operationIndex: model.operationIndex + 1,
            },
            canUndo: true,
            canRedo: model.operationIndex < model.operations.length - 2,
            isDirty: true,
          });
        },

        // UI state
        setSelectedEntity: entityId => {
          set({ selectedEntityId: entityId });
        },

        setSelectedRule: ruleId => {
          set({ selectedRuleId: ruleId });
        },

        setShowFormulas: show => {
          set({ showFormulas: show });
        },

        setExplainMode: enabled => {
          set({ explainMode: enabled });
        },

        // Errors
        addError: error => {
          set(state => ({ errors: [...state.errors, error] }));
        },

        clearErrors: () => {
          set({ errors: [] });
        },

        // Export
        exportModel: () => {
          return get().model;
        },
      }),
      {
        name: 'lattice-storage',
        partialize: state => ({
          model: state.model,
          activeViewId: state.activeViewId,
          activeScenarioId: state.activeScenarioId,
          showFormulas: state.showFormulas,
        }),
      }
    )
  )
);

// SELECTORS

export const selectLatticeModel = (state: LatticeStore) => state.model;
const EMPTY_ARRAY = Object.freeze([]) as never[];

export const selectEntities = (state: LatticeStore) => state.model?.data.entities ?? EMPTY_ARRAY;
export const selectRules = (state: LatticeStore) => state.model?.rules.rules ?? EMPTY_ARRAY;
export const selectViews = (state: LatticeStore) => state.model?.views.views ?? EMPTY_ARRAY;
export const selectScenarios = (state: LatticeStore) => state.model?.scenarios ?? EMPTY_ARRAY;
export const selectComputedValues = (state: LatticeStore) => state.computedValues;
export const selectIsComputing = (state: LatticeStore) => state.isComputing;
export const selectCanUndo = (state: LatticeStore) => state.canUndo;
export const selectCanRedo = (state: LatticeStore) => state.canRedo;
export const selectIsDirty = (state: LatticeStore) => state.isDirty;
