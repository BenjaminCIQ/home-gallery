import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SingleViewStore {
  lastId: string
  lastIndex: number
  showDetails: boolean
  showAnnotations: boolean
  showNavigation: boolean
  isSlideshowActive: boolean
  hideNavigation: boolean
  shuffledIndex: number
  shuffledIndices: number[]
  loopImages: boolean
  shuffleImages: boolean
  shuffleDirty: boolean
  resetSearchOnLoopEnd: boolean
  slideshowInterval: number
  slideshowTimeout: number
  navigationTimeout: number

  setLastId(lastId: string): void
  setLastIndex(lastIndex: number): void
  setShowDetails(show: boolean): void
  setShowAnnotations(show: boolean): void
  toggleShowNavigation(): void
  setIsSlideshowActive(active: boolean): void
  setHideNavigation(hide: boolean): void
  setShuffledIndex(shuffledIndex: number): void
  setShuffledIndices(indices: number[]): void
  clearShuffledIndices(): void
  setLoopImages(v: boolean): void
  setResetSearchOnLoopEnd(v: boolean): void
  setShuffleImages(v: boolean): void
  clearShuffleDirty(): void
  setSlideshowInterval(v: boolean): void
  setSlideshowTimeout(v: boolean): void
  setNavigationTimeout(v: boolean): void
}

const excludeStateProps = (excludeProps: string[] = []) => (state: any): any => Object.fromEntries(
  Object.entries(state).filter(([key]) => !excludeProps.includes(key)))

export const useSingleViewStore = create<
  SingleViewStore,
  [
    ["zustand/persist", SingleViewStore]
  ]
>(
  persist((set) => ({
  lastId: '',
  lastIndex: -1,
  showDetails: false,
  showAnnotations: false,
  showNavigation: true,
  isSlideshowActive: false,
  hideNavigation: false,
  shuffledIndices: [],
  shuffledIndex: 0,
  loopImages: true,
  shuffleImages: true,
  shuffleDirty: false,
  resetSearchOnLoopEnd: true,
  slideshowInterval: 5000,
  slideshowTimeout: 30000,
  navigationTimeout: 5000,

  setLastId: (lastId: string) => set((state: SingleViewStore) => ({...state, lastId})),
  setLastIndex: (lastIndex: number) => set((state: SingleViewStore) => ({...state, lastIndex})),
  setShowDetails: (show: boolean) => set((state: SingleViewStore) => ({...state, showDetails: show})),
  setShowAnnotations: (show: boolean) => set((state: SingleViewStore) => ({...state, showAnnotations: show})),
  toggleShowNavigation: () => set(state => ({showNavigation: !state.showNavigation})),
  setIsSlideshowActive: (active: boolean) => set((state) => ({ ...state, isSlideshowActive: active })),
  setHideNavigation: (hide: boolean) => set((state) => ({ ...state, hideNavigation: hide })),
  setShuffledIndex: (shuffledIndex: number) => set((state: SingleViewStore) => ({...state, shuffledIndex})),
  setShuffledIndices: (indices: number[]) => set((state) => ({ ...state, shuffledIndices: indices })),
  setLoopImages: (v) => set({ loopImages: v }),
  setShuffleImages: (v) => set(state => ({shuffleImages: v, shuffleDirty: true})),
  clearShuffleDirty: () =>set({ shuffleDirty: false }),
  setResetSearchOnLoopEnd: (v) => set({ resetSearchOnLoopEnd: v}),
  setSlideshowInterval: (v) => set({ slideshowInterval: v }),
  setSlideshowTimeout: (v) => set({ slideshowTimeout: v }),
  setNavigationTimeout: (v) => set({ navigationTimeout: v }),
}), {
  name: 'gallery-single-view',
  partialize: excludeStateProps(['lastId', 'lastIndex']),
}))
