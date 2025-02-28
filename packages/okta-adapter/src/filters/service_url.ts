/*
 *                      Copyright 2024 Salto Labs Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { filters } from '@salto-io/adapter-components'
import { FilterContext, PRIVATE_API_DEFINITIONS_CONFIG } from '../config'
import { FilterCreator, FilterResult } from '../filter'
import OktaClient from '../client/client'
import { getAdminUrl } from '../client/admin'

const filter: FilterCreator = params =>
  filters.serviceUrlFilterCreator<OktaClient, FilterContext, FilterResult>(
    getAdminUrl(params.client.baseUrl) ?? params.client.baseUrl,
    params.config[PRIVATE_API_DEFINITIONS_CONFIG],
  )(params)

export default filter
