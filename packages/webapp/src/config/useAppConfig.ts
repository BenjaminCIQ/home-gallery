import { useMemo } from "react";
import { type AppConfig } from "./AppConfig";

const defaultConfig: AppConfig = {
  title: 'Home Gallery',
  disabled: [],
  pluginManager: {
    plugins: []
  },
  entries: [],
  slideshow: {
    interval: 5000,
    naviTimeout: 3000,
    timeout: 60000,
    random: true,
    loop: true,
  }
}

export const useAppConfig = () => {
  return useMemo(() => {
    const injectedConfig = window['__homeGallery'] || {};

    const pluginManager = {
      ...defaultConfig.pluginManager,
      ...injectedConfig.pluginManager
    }

    const slideshow = {
      ...defaultConfig.slideshow,
      ...injectedConfig.slideshow
    };

    const result = {
      ...defaultConfig,
      ...injectedConfig,
      pluginManager,
      slideshow
    };

    const searchParams = new URLSearchParams(location.search?.substring(1) || '')
    result.disabled.push(...searchParams.getAll('disabled').filter(v => !!v))

    return result as AppConfig
  }, [])
}
