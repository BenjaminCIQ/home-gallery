import * as React from "react";
import { useState, useEffect, useRef } from "react";
import {
  useParams,
  useLocation,
  useNavigate
} from "react-router-dom";
import Hammer from 'hammerjs';
import { useHotkeys } from 'react-hotkeys-hook';
import Logger from '@home-gallery/logger'

import { useAppConfig } from "../config/useAppConfig";
import { useEntryStore } from "../store/entry-store";
import { useSearchStore } from "../store/search-store";
import { useSingleViewStore } from "../store/single-view-store";
import useListLocation from '../utils/useListLocation';

import { MediaNav } from './MediaNav';
import { MediaViewUnknownType } from './MediaViewUnknownType';
import { MediaViewImage } from './MediaViewImage';
import { MediaViewVideo } from './MediaViewVideo';
import { Details } from './Details';
import { Zoomable } from "./Zoomable";
import useBodyDimensions from "../utils/useBodyDimensions";
import { classNames } from '../utils/class-names'
import { SingleTagDialogProvider } from "../dialog/tag-dialog-provider";
import { useMediaViewHotkeys } from "./useMediaViewHotkeys";
import { MediaViewDisableFlags } from "./MediaViewPage";

const log = Logger('MediaView')

const findEntryIndex = (location, entries, id) => {
  if (location.state?.index && entries[location.state.index]?.id.startsWith(id)) {
    return location.state.index;
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id.startsWith(id)) {
      return i;
    }
  }
  return -1;
}

const scaleDimensions = (media, device) => {
  if (!media) {
    return { width: device.width, height: device.height }
  }
  const mediaRatio = media.height / (media.width || 1);
  const deviceRatio = device.height / (device.width || 1);
  if (deviceRatio < mediaRatio) {
    return { width: device.height / mediaRatio, height: device.height }
  } else {
    return { width: device.width, height: device.width * mediaRatio }
  }
}

const encodeUrl = (url: string) => url.replace(/[\/]/g, char => encodeURIComponent(char))

export const MediaView = () => {
  const appConfig = useAppConfig();
  const disableFlags = appConfig.pages?.mediaView?.disabled || [] as MediaViewDisableFlags
  let { id } = useParams();
  let location = useLocation();
  const navigate = useNavigate();
  const listLocation = useListLocation();
  const dimensions = useBodyDimensions();

  const entries = useEntryStore(state => state.entries);
  const lastIndex = useSingleViewStore(state => state.lastIndex);
  const showDetails = useSingleViewStore(state => state.showDetails);
  const showAnnotations = useSingleViewStore(state => state.showAnnotations);
  const showNavigation = useSingleViewStore(state => state.showNavigation);
  const lastId = useSingleViewStore(state => state.lastId);
  const setLastId = useSingleViewStore(state => state.setLastId);
  const setLastIndex = useSingleViewStore(state => state.setLastIndex);
  const search = useSearchStore(state => state.search);
  const setShowDetails = useSingleViewStore(actions => actions.setShowDetails);
  const setShowAnnotations = useSingleViewStore(actions => actions.setShowAnnotations);
  const setShowNavigation = useSingleViewStore(actions => actions.setShowNavigation);

  const isSlideshowActive = useSingleViewStore(state => state.isSlideshowActive)
  const setIsSlideshowActive = useSingleViewStore(actions => actions.setIsSlideshowActive)

  const hideNavigation = useSingleViewStore(state => state.hideNavigation)
  const setHideNavigation = useSingleViewStore(actions => actions.setHideNavigation)

  const shuffledIndex = useSingleViewStore(state => state.shuffledIndex)
  const setShuffledIndex = useSingleViewStore(actions => actions.setShuffledIndex)
  const shuffledIndices = useSingleViewStore(state => state.shuffledIndices)
  const setShuffledIndices = useSingleViewStore(actions => actions.setShuffledIndices)

  const slideshowIntervalRef = useRef<number | null>(null);
  const inactivityTimeoutRef = useRef<number | null>(null);
  const navigationTimeoutRef = useRef<number | null>(null);

  const slideshowInterval = appConfig.slideshow?.interval || 5000;
  const navigationTimeout = appConfig.slideshow?.naviTimeout || 3000;
  const slideshowTimeout = appConfig.slideshow?.timeout || 60000;
  const isSlideshowRandomised = appConfig.slideshow?.random || true; //shuffle
  const loopImages = appConfig.slideshow?.loop || true; //loop
  const searchResetOnLoopEnd = true; // or timer based??
  
  const [zoomFactor, setZoomFactor] = useState(1)

  const [hotkeys, hotkeyToAction] = useMediaViewHotkeys();

  let index = findEntryIndex(location, entries, id);

  const current = entries[index];
  const prev = entries[lastIndex];
  let next = entries[index + 1];

  const isImage = current && (current.type === 'image' || current.type === 'rawImage');
  const isVideo = current && (current.type === 'video')
  const isUnknown = !current || (['image', 'rawImage', 'video'].indexOf(current.type) < 0)

  const key = current ? current.id : (Math.random() * 100000).toFixed(0);

  useEffect(() => { id && setLastId(id) }, [id])
  useEffect(() => { index >= 0 && setLastIndex(index) }, [index])

  useEffect(() => {
    if (!isSlideshowActive || entries.length === 0) return;

    console.log('Entries updated during slideshow (end of filtered)', entries);
    
    // Update shuffled order in store
    reshuffle();

    // Start slideshow from first entry
    viewEntry(0);
  }, [entries, isSlideshowActive])

  const startNavigationHideTimeout = () => {
    if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);

    navigationTimeoutRef.current = setTimeout(() => {
      setHideNavigation(true);
    }, navigationTimeout);
  };


  useEffect(() => {
    // Start inactivity timer if slideshow is not active
    if (!isSlideshowActive) {
      inactivityTimeoutRef.current = setTimeout(() => {
        console.log('Inactivity timeout reached — starting slideshow');
        dispatch({ type: 'toggleSlideshow', fromSlideshow: true });
      }, slideshowTimeout);
    }

    // If slideshow and showNavigation has been activated, set timeout
    if (isSlideshowActive && showNavigation)
    {
      startNavigationHideTimeout();
    }

    if (entries.length && !shuffleIndices.length)
    {
      reshuffle();
    }

    return () => {
      if (slideshowIntervalRef.current) clearInterval(slideshowIntervalRef.current);
      if (inactivityTimeoutRef.current) clearTimeout(inactivityTimeoutRef.current);
      if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);
    };
  }, []);


  const viewEntry = (index: number) => {
    const { shortId } = entries[index]
    navigate(`/view/${shortId}`, {state: {index, listLocation}, replace: true});
  }

  // Helper function for random shuffling of the images to ensure random order single show
  const shuffleIndices = (length: number) => {
    const indices = [...Array(length).keys()]; // [0, 1, 2, ...]
  
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    return indices;
  }

  const reshuffle = () => {
    const newShuffle = isSlideshowRandomised ? shuffleIndices(entries.length) : [...Array(entries.length).keys()]

      setShuffledIndex(0);
      setShuffledIndices(newShuffle);
      next = entries[shuffledIndices[1]];
  }

  const startSlideshow = () => {
    if (!isSlideshowActive && entries.length) {
      setIsSlideshowActive(true);
      setHideNavigation(true);
      if (slideshowIntervalRef.current) clearInterval(slideshowIntervalRef.current);
      slideshowIntervalRef.current = setInterval(() => {
        dispatch({ type: 'next', fromSlideshow: true });
      }, slideshowInterval);
    }
  };

  const stopSlideshow = () => {
    if (isSlideshowActive) {
      setIsSlideshowActive(false);
      setHideNavigation(false);
      if (slideshowIntervalRef.current) clearInterval(slideshowIntervalRef.current);
    }
  };

  const dispatch = (action: any) => {
    const { type, fromSlideshow } = action;
    
    if (!fromSlideshow) {
      stopSlideshow();
    }

    let prevNextMatch = type.match(/(prev|next)(-(\d+))?/)
    if (type === 'index') {
      const i = Math.min(entries.length - 1, Math.max(0, action.index))
      viewEntry(i)
    } else if (prevNextMatch && entries.length) {
      const offset = prevNextMatch[3] ? +prevNextMatch[3] : 1
      const negate = prevNextMatch[1] == 'prev' ? -1 : 1

      let i = shuffledIndex + (negate * offset);

      // If end of indices reached
      if (i >= shuffledIndices.length) {
        // reset search query if slideshowActive and searchResetOnLoopEnd
        if (isSlideshowActive && search.value && searchResetOnLoopEnd) {
          search({type: 'none'});
          // Wait for useEffect to trigger on updated entries
        }
        // if no search value and not looping, then if loop is active,
        // then images should be reshuffled and viewing can continue
        if (loopImages) {
          i = (i + entries.length) % entries.length;
          reshuffle();
          setShuffledIndex(i);
          viewEntry(shuffledIndices[shuffledIndex]);
        } else {
          stopSlideshow();
          setShuffledIndex(shuffleIndices.length - 1);
          viewEntry(shuffledIndices[shuffledIndex]); // goto last image
        }
      } else {
        // if negative, then just go to last id (if exists) - this will be somewhere else in the shuffledIndices sequence though...going forward again won't take you back to the first image
        // could be solved by storing a boolean if this event happens, then if next is called again, set index to -1 and add (negate * offset) from there
        if (i < 0) {
          if (lastId != '') {
            // by not updating the shuffledIndex, calling next/prev again will go back to where it had been in the beginning of the shuffledIndices
            viewEntry(findEntryIndex(location, entries, lastId));
          }
        } else {
          setShuffledIndex(i);
          viewEntry(shuffledIndices[shuffledIndex]); // normal case where loop has not ended
        }
      }
    } else if (type === 'toggleSlideshow') {
      if (isSlideshowActive) {
        stopSlideshow();
      } else {
        startSlideshow();
      }
    } else if (type === 'similar' && current?.similarityHash && !disableFlags.includes('annotation')) {
      navigate(`/similar/${current.shortId}`);
    } else if (type === 'toggleDetails' && !disableFlags.includes('detail')) {
      setShowDetails(!showDetails);
    } else if (type === 'toggleAnnotations' && !disableFlags.includes('annotation')) {
      setShowAnnotations(!showAnnotations);
    } else if (type === 'toggleNavigation') {
      setShowNavigation(!showNavigation);
      if (isSlideshowActive && showNavigation) {
        startNavigationHideTimeout();
      }
    } else if (type == 'first' && entries.length) {
      setShuffledIndex(shuffledIndices.indexOf(0)); // equal to shuffledIndices[shuffledIndex]
      viewEntry(0);
    } else if (type == 'last' && entries.length) {
      setShuffledIndex(shuffledIndices.indexOf(entries.length - 1));
      viewEntry(entries.length - 1); // equal to shuffledIndices[shuffledIndex]
    } else if (type == 'list') {
      navigate(`${listLocation.pathname}${listLocation.search ? encodeUrl(listLocation.search) : ''}`, {state: {id: current?.id}});
    } else if (type == 'chronology') {
      search({type: 'none'});
      navigate('/');
    } else if (type == 'play') {
      setHideNavigation(true);
    } else if (type == 'pause') {
      setHideNavigation(false);
    } else if (type == 'search') {
      navigate(`/search/${encodeUrl(action.query)}`);
    } else if (type == 'map' && current?.latitude && current?.longitude && !disableFlags.includes('map')) {
      navigate(`/map?lat=${current.latitude.toFixed(5)}&lng=${current.longitude.toFixed(5)}&zoom=14`, {state: {listLocation}})
    }
  }

  const onSwipe = (ev) => {
    if (ev.direction === Hammer.DIRECTION_LEFT) {
      dispatch({type: 'next'})
    } else if (ev.direction === Hammer.DIRECTION_RIGHT) {
      dispatch({type: 'prev'})
    }
  }

  useHotkeys(hotkeys, (ev, handler) => {
    const handlerKey = (handler.ctrl ? 'ctrl+' : '') + (handler.shift ? 'shift+' : '') + (handler.alt ? 'alt+' : '') + (handler.keys || []).join('+')
    const action = hotkeyToAction[handlerKey]

    if (!action) {
      log.warn(`Hotkey action of ${handlerKey} not found`)
      return
    }

    dispatch({type: action})
    ev.preventDefault()
  }, [index, showDetails, showAnnotations, showNavigation])

  const mediaVanishes = index < 0 && lastIndex >= 0 && entries.length > 0
  if (mediaVanishes) {
    dispatch({type: 'index', index: lastIndex})
  }
  const listBecomesEmpty = entries.length == 0 && lastIndex >= 0
  if (listBecomesEmpty) {
    dispatch({type: 'list'})
  }

  console.log('Media object', current);

  return (
    <>
      <SingleTagDialogProvider>
        <div className="flex flex-col w-screen md:flex-row h-dvh">
          <div className={classNames('w-full', {'h-1/2 flex-shrink-0 md:flex-shrink md:h-full': showDetails, 'h-full': !showDetails})}>
            <div className="relative w-full h-full overflow-hidden">
              {!hideNavigation && showNavigation &&
                <MediaNav current={current} prev={prev} next={next} listLocation={listLocation} showNavigation={showNavigation} dispatch={dispatch} isSlideshowActive={isSlideshowActive} />
              }
              {isImage &&
                <Zoomable key={key} childWidth={current.width} childHeight={current.height} dispatch={dispatch} onSwipe={onSwipe} onZoom={setZoomFactor}>
                  <MediaViewImage key={key} media={current} next={next} prev={prev} showAnnotations={showAnnotations} zoomFactor={zoomFactor}/>
                </Zoomable>
              }
              {isVideo &&
                <MediaViewVideo key={key} media={current} next={next} prev={prev} dispatch={dispatch} isSlideshowActive={isSlideshowActive} />
              }
              {isUnknown &&
                <MediaViewUnknownType key={key} media={current} next={next} prev={prev}/>
              }
            </div>
          </div>
          { showDetails &&
            <div className="md:w-90">
              <Details entry={current} dispatch={dispatch} />
            </div>
          }
        </div>
      </SingleTagDialogProvider>
    </>
  )
}

