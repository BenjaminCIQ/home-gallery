import * as React from "react";
import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useEntryStore } from "../store/entry-store";
import { useEditModeStore } from '../store/edit-mode-store';
import { useSingleViewStore } from "../store/single-view-store";

import { FluentList } from "./FluentList";
import { NavBar } from "../navbar/NavBar";
import { Scrollbar } from "./scrollbar";

import useBodyDimensions from '../utils/useBodyDimensions';
import { useDeviceType, DeviceType } from "../utils/useDeviceType";
import { fluent } from "./fluent";
import { MultiTagDialogProvider } from "../dialog/tag-dialog-provider";

const NAV_HEIGHT = 44
const BOTTOM_MARGIN = 4

const useViewHeight = (offset) => {
  const getHeight = () => (document.documentElement.clientHeight)+ offset
  const [height, setHeight] = useState(getHeight())

  const onResize = () => setHeight(getHeight())

  useEffect(() => {
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return height
}

const idleEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll']

// Photo frame: after the slideshow start timeout without interaction, start the slideshow on a random image
const useIdleSlideshow = () => {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    let timer: number | undefined
    const restart = () => {
      clearTimeout(timer)
      timer = window.setTimeout(start, useSingleViewStore.getState().slideshowTimeout)
    }
    const start = () => {
      const { entries } = useEntryStore.getState()
      if (!entries.length) return restart()
      const index = Math.floor(Math.random() * entries.length)
      const singleView = useSingleViewStore.getState()
      singleView.setIsSlideshowActive(true)
      if (singleView.showNavigation) singleView.toggleShowNavigation()
      navigate(`/view/${entries[index].shortId}`, {state: {listLocation: location, index}})
    }

    idleEvents.forEach(name => window.addEventListener(name, restart, {passive: true}))
    restart()
    return () => {
      clearTimeout(timer)
      idleEvents.forEach(name => window.removeEventListener(name, restart))
    }
  }, [location])
}

const mobileRowHeights = {minHeight: 75, maxHeight: 110, maxPotraitHeight: 185}
const desktopRowHeights = {minHeight: 120, maxHeight: 200, maxPotraitHeight: 280}

export const List = () => {
  const entries = useEntryStore(state => state.entries)

  const showSelected = useEditModeStore(state => state.showSelected);
  const selectedIds = useEditModeStore(state => state.selectedIds);

  const containerRef = useRef(window)
  useIdleSlideshow()

  const { width, height } = useBodyDimensions();
  const [ deviceType ] = useDeviceType();

  const viewHeight = height - NAV_HEIGHT - BOTTOM_MARGIN
  const padding = 8

  const visibleEntries = useMemo(() => {
    if (!showSelected) {
      return entries
    }
    return entries.filter(entry => selectedIds[entry.id])
  }, [showSelected, selectedIds, entries])

  const rows = useMemo(() => {
    const rowHeights = deviceType === DeviceType.MOBILE ? mobileRowHeights : desktopRowHeights
    return fluent(visibleEntries, {padding, width, ...rowHeights});
  }, [width, visibleEntries, deviceType])

  const topDateItems = useMemo(() => {
    return rows.map(({top, height, columns}) => ({top, height, date: columns[0].item?.date || '1970-01-01T00:00:00', dateValue: '1970'}))
  }, [rows])


  return (
    <>
      <MultiTagDialogProvider>
        <>
          <NavBar />
          <div className="relative z-0">
            <Scrollbar containerRef={containerRef}
              style={{marginTop: 0, marginBottom: BOTTOM_MARGIN}}
              pageHeight={viewHeight}
              topDateItems={topDateItems} />
            <FluentList rows={rows} padding={padding} />
          </div>
        </>
      </MultiTagDialogProvider>
    </>
  )
}