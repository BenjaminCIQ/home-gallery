import * as React from "react";
import { useState } from "react";
import * as icons from '@fortawesome/free-solid-svg-icons'

import { useEditModeStore, ViewMode } from '../store/edit-mode-store';
import { useTagDialog } from "../dialog/use-tag-dialog";
import { addTags } from '../api/ApiService';
import { useDeviceType, DeviceType } from "../utils/useDeviceType";
import { type Tag } from "../api/models";

import { EditNavBar } from './EditNavBar';
import { NavItem } from './NavItem';
import { ViewNavBar } from './ViewNavBar';
import { SearchInput, SearchButton } from "./SearchInput";
import { SyncNotificationInbox } from './SyncNotificationInbox';

export const DesktopNavBar = ({disableEdit = false, showDialog}) => {
  const viewMode = useEditModeStore(state => state.viewMode);

  return (
    <>
      <nav className="sticky top-0 z-10 bg-gray-800">
        <div className="mx-auto">
          <div className="relative flex items-center justify-between h-12">
            <div className="flex px-2 space-x-2 overflow-x-visible">
              { viewMode === ViewMode.VIEW && (
                <ViewNavBar disableEdit={disableEdit}/>
              )}
              { viewMode === ViewMode.EDIT && (
                <EditNavBar showDialog={showDialog}/>
              )}
            </div>
            <div className="flex pr-2 space-x-4 items-center">
              <SyncNotificationInbox />
              <SearchInput focus={false} />
            </div>
          </div>
        </div>
      </nav>
    </>
  )
}

export const MobileNavBar = ({disableEdit = false, showDialog}) => {
  const [showSearch, setShowSearch] = useState(false)
  const viewMode = useEditModeStore(state => state.viewMode);

  return (
    <>
      <nav className="sticky top-0 z-10 bg-gray-800">
        <div className="mx-auto">
          <div className="relative flex items-center justify-between h-12">
            <div className="flex px-2 space-x-2 overflow-x-visible min-w-0 grow">
              { !showSearch && (
                <>
                  { viewMode === ViewMode.VIEW && (
                    <ViewNavBar disableEdit={disableEdit}/>
                  )}
                  { viewMode === ViewMode.EDIT && (
                    <EditNavBar showDialog={showDialog}/>
                  )}
                </>
              )}
              { showSearch && (
                <NavItem icon={icons.faArrowLeft} onClick={() => setShowSearch(false)} />
              )}
            </div>
            <div className="flex pr-2 space-x-2 items-center shrink-0">
              <SyncNotificationInbox />
              { !showSearch && (
                <div className="overflow-hidden border-gray-500 rounded">
                  <SearchButton onClick={() => setShowSearch(true)}/>
                </div>
              )}
              { showSearch && (
                <div className="overflow-hidden border-gray-500 rounded w-[min(100vw-8rem,20rem)]">
                  <SearchInput focus={true} />
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
    </>
  )
}

export const NavBar = ({disableEdit = false}) => {
  const [ deviceType ] = useDeviceType();
  const { setDialogVisible, openDialog } = useTagDialog()

  const selectedIds = useEditModeStore(state => state.selectedIds);

  const onSubmit = ({tags} : {tags: Tag[]}) => {
    const entryIds = Object.entries(selectedIds).filter(([_, selected]) => selected).map(([id]) => id)
    addTags(entryIds, tags).then(() => {
      setDialogVisible(false);
    })

    return false;
  }

  const showDialog = () => {
    openDialog({onSubmit})
  }

  return (
    <>
      { deviceType === DeviceType.DESKTOP &&
        <DesktopNavBar showDialog={showDialog} disableEdit={disableEdit} />
      }
      { deviceType === DeviceType.MOBILE &&
        <MobileNavBar showDialog={showDialog} disableEdit={disableEdit} />
      }
    </>
  )
}
