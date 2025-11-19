import * as React from "react";
import { useEffect } from "react";

import { List } from './List';
import { useSearchStore } from '../store/search-store'
import { useSingleViewStore } from "../store/single-view-store";

export const AllView = () => {
  const search = useSearchStore(state => state.search);
  const setIsSlideshowActive = useSingleViewStore(actions => actions.setIsSlideshowActive)
  const setShuffledIndices = useSingleViewStore(actions => actions.setShuffledIndices)
  const toggleShowNavigation = useSingleViewStore(actions => actions.toggleShowNavigation);

  useEffect(() => {
    search({type: 'none'});
    setIsSlideshowActive(false);
    if (!useSingleViewStore.getState().showNavigation) toggleShowNavigation();
    setShuffledIndices([]);
  }, [])

  return ( 
    <>
      <List />
    </>
  )
}
