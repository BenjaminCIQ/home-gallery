import * as React from "react";
import { useState, useEffect } from "react";
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
  const setLastId = useSingleViewStore(state => state.setLastId);
  const setLastIndex = useSingleViewStore(state => state.setLastIndex);
  const search = useSearchStore(state => state.search);
  const setShowDetails = useSingleViewStore(actions => actions.setShowDetails);
  const setShowAnnotations = useSingleViewStore(actions => actions.setShowAnnotations);
  const setShowNavigation = useSingleViewStore(actions => actions.setShowNavigation);

  const [hideNavigation, setHideNavigation] = useState(false)
  const [zoomFactor, setZoomFactor] = useState(1)

  // Slideshow
  const [isSlideshowActive, setIsSlideshowActive] = useState(false);
  const [slideshowIntervalId, setSlideshowIntervalId] = useState(null);
  const [inactivityTimeoutId, setInactivityTimeoutId] = useState(null);

  const slideshowDelay = appConfig.slideshow?.interval || 3000;
  const slideshowTimeout = appConfig.slideshow?.timeout || 60000;
  const isSlideshowRandom = !!appConfig.slideshow?.random || true;

  const [hotkeys, hotkeyToAction] = useMediaViewHotkeys();

  let index = findEntryIndex(location, entries, id);

  const current = entries[index];
  const prev = entries[index - 1];
  const next = entries[index + 1];

  const isImage = current && (current.type === 'image' || current.type === 'rawImage');
  const isVideo = current && (current.type === 'video')
  const isUnknown = !current || (['image', 'rawImage', 'video'].indexOf(current.type) < 0)

  const key = current ? current.id : (Math.random() * 100000).toFixed(0);

  useEffect(() => { id && setLastId(id) }, [id])
  useEffect(() => { index >= 0 && setLastIndex(index) }, [index])

  useEffect(() => {
    return () => {
      stopSlideshow();
      if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId);
    };
  }, []);

  const viewEntry = (index: number) => {
    const { shortId } = entries[index]
    navigate(`/view/${shortId}`, {state: {index, listLocation}, replace: true});
  }

  const resetInactivityTimer = () => {
    if (inactivityTimeoutId) {
      clearTimeout(inactivityTimeoutId);
    }

    const id = setTimeout(() => {
      if (!isSlideshowActive) {
        console.log('Inactivity timeout reached — restarting slideshow');
        dispatch({ type: 'toggleSlideshow', fromSlideshow: true});
      }
    }, slideshowTimeout);

    setInactivityTimeoutId(id);
  };

  const startSlideshow = () => {
    if (!isSlideshowActive) {
      setIsSlideshowActive(true);
      setHideNavigation(true);
      const id = setInterval(() => dispatch({ type: 'next', fromSlideshow: true }), slideshowDelay);
      setSlideshowIntervalId(id);
    }
  };

  const stopSlideshow = () => {
    if (isSlideshowActive) {
      setIsSlideshowActive(false);
      setHideNavigation(false);
      clearInterval(slideshowIntervalId);
      setSlideshowIntervalId(null);
    }
  };

  const dispatch = (action: any) => {
    const { type, fromSlideshow } = action;
    
    if (!fromSlideshow) {
      stopSlideshow();
      resetInactivityTimer();
    }

    let prevNextMatch = type.match(/(prev|next)(-(\d+))?/)
    if (type === 'index') {
      const i = Math.min(entries.length - 1, Math.max(0, action.index))
      viewEntry(i)
    } else if (prevNextMatch && entries.length) {
      let i;
      if (isSlideshowActive && isSlideshowRandom && fromSlideshow) {
        // Slideshow interval in random mode → pick a random index
        i = Math.floor(Math.random() * entries.length);
      } else {
        const offset = prevNextMatch[3] ? +prevNextMatch[3] : 1
        const negate = prevNextMatch[1] == 'prev' ? -1 : 1
        i = Math.min(entries.length - 1, Math.max(0, index + (negate * offset)))
      }
      viewEntry(i)
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
    } else if (type == 'first' && entries.length) {
      viewEntry(0)
    } else if (type == 'last' && entries.length) {
      viewEntry(entries.length - 1)
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
                <Zoomable key={key} childWidth={current.width} childHeight={current.height} onSwipe={onSwipe} onZoom={setZoomFactor}>
                  <MediaViewImage key={key} media={current} next={next} prev={prev} showAnnotations={showAnnotations} zoomFactor={zoomFactor}/>
                </Zoomable>
              }
              {isVideo &&
                <MediaViewVideo key={key} media={current} next={next} prev={prev} dispatch={dispatch}/>
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

