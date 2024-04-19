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
import {
  Change,
  ChangeError,
  ChangeValidator,
  getChangeData,
  InstanceElement,
  isAdditionOrModificationChange,
  isInstanceElement,
  ReferenceExpression,
  ReadOnlyElementsSource,
  CORE_ANNOTATIONS,
  ElemID,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { ISSUE_LAYOUT_TYPE } from '../constants'
import JiraClient from '../client/client'
import { JiraConfig } from '../config/config'

type issueTypeMappingStruct = {
  issueTypeId: string | ReferenceExpression
  screenSchemeId: ReferenceExpression
}

const parentElemID = (instance: InstanceElement): ElemID | undefined =>
  instance.annotations[CORE_ANNOTATIONS.PARENT]?.[0]?.elemID

// Filters and deletes from the issueTypeMapping the issue layouts that are not in the issueTypeScheme of the project
const isIssueTypeInIssueTypeScheme = (
  issueTypeMapping: issueTypeMappingStruct,
  projectIssueTypesFullName: string[],
): boolean =>
  _.isString(issueTypeMapping.issueTypeId) ||
  projectIssueTypesFullName?.includes(issueTypeMapping.issueTypeId?.elemID.getFullName())

// temporary will be used from the filter
const isRelevantMapping = (
  issueTypeScreenScheme: issueTypeMappingStruct,
  relevantIssueTypeMappingsLength: number,
  projectIssueTypesFullNameLength: number,
): boolean =>
  issueTypeScreenScheme.issueTypeId !== 'default' || relevantIssueTypeMappingsLength <= projectIssueTypesFullNameLength

const getIssueLayoutsListByProject = (changes: ReadonlyArray<Change>): InstanceElement[][] =>
  Object.values(
    _.groupBy(
      changes
        .filter(isAdditionOrModificationChange)
        .map(getChangeData)
        .filter(isInstanceElement)
        .filter(instance => instance.elemID.typeName === ISSUE_LAYOUT_TYPE),
      instance => parentElemID(instance)?.getFullName(),
    ),
  )

const getProjectIssueLayoutsScreensName = async (
  elementsSource: ReadOnlyElementsSource,
  projectElemID: ElemID | undefined,
): Promise<string[]> => {
  const project = projectElemID !== undefined ? await elementsSource.get(projectElemID) : undefined
  if (project === undefined) return []
  const projectIssueTypesFullName =
    project.value.issueTypeScheme !== undefined
      ? (await elementsSource.get(project.value.issueTypeScheme.elemID))?.value.issueTypeIds
          ?.filter(
            (issueType: ReferenceExpression | number | string) =>
              typeof issueType !== 'string' && typeof issueType !== 'number',
          )
          ?.map((issueType: ReferenceExpression) => issueType.elemID.getFullName())
      : []

  const relevantIssueTypeMappings = (
    (await Promise.all(
      project.value.issueTypeScreenScheme !== undefined
        ? (await elementsSource.get(project.value.issueTypeScreenScheme.elemID))?.value.issueTypeMappings ?? []
        : [],
    )) as issueTypeMappingStruct[]
  ).filter(issueTypeScreenScheme => isIssueTypeInIssueTypeScheme(issueTypeScreenScheme, projectIssueTypesFullName))

  return (
    await Promise.all(
      relevantIssueTypeMappings
        .filter(issueTypeScreenScheme =>
          isRelevantMapping(issueTypeScreenScheme, relevantIssueTypeMappings.length, projectIssueTypesFullName.length),
        )
        .map(issueTypeMapping => elementsSource.get(issueTypeMapping.screenSchemeId.elemID)),
    )
  )
    .filter(isInstanceElement)
    .filter(
      (screenScheme: InstanceElement) =>
        screenScheme.value.screens?.default !== undefined || screenScheme.value.screens?.view !== undefined,
    )
    .flatMap((screenScheme: InstanceElement) => screenScheme.value.screens.view ?? screenScheme.value.screens.default)
    .map((screen: ReferenceExpression) => screen.elemID.getFullName())
}

// this change validator ensures the correctness of issue layout configurations within each project,
// by validating that each issue layout is linked to a valid screen according to his specific project
// we also check that the issue layout is linked to a relevant project

export const issueLayoutsValidator: (client: JiraClient, config: JiraConfig) => ChangeValidator =
  (client, config) => async (changes, elementsSource) => {
    const errors: ChangeError[] = []
    if (client.isDataCenter || !config.fetch.enableIssueLayouts || elementsSource === undefined) {
      return errors
    }

    const issueLayoutsListByProject = getIssueLayoutsListByProject(changes)
    await Promise.all(
      issueLayoutsListByProject.map(async instances => {
        // I use the first issueLayout of the sub-list of the issueLayouts to get the projectId of the project that this issueLayouts linked to
        // and I need to do it just for the first issueLayout because all the issueLayouts in this sub-list are linked to the same project
        const issueLayoutsScreens = await getProjectIssueLayoutsScreensName(elementsSource, parentElemID(instances[0]))

        await Promise.all(
          instances
            .filter(
              issueLayoutInstance =>
                issueLayoutInstance.value.extraDefinerId === undefined ||
                !issueLayoutsScreens.includes(issueLayoutInstance.value.extraDefinerId.elemID.getFullName()),
            )
            .map(async issueLayoutInstance => {
              errors.push({
                elemID: issueLayoutInstance.elemID,
                severity: 'Error',
                message: 'Invalid screen in Issue Layout',
                detailedMessage: 'This issue layout references an invalid or non-existing screen.',
              })
            }),
        )
      }),
    )

    return errors
  }
