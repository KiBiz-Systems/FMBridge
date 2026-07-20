'use strict';

// FileMaker Pro calculation functions for autocomplete. Signature text is shown
// in the completion detail; insertion places the cursor inside the parens.
const FUNCTIONS = [
  // Text
  'Char ( number )', 'Code ( text )', 'Exact ( originalText ; comparisonText )',
  'Filter ( textToFilter ; filterText )', 'FilterValues ( textToFilter ; filterValues )',
  'GetValue ( listOfValues ; valueNumber )', 'Left ( text ; numberOfCharacters )',
  'LeftValues ( text ; numberOfValues )', 'LeftWords ( text ; numberOfWords )',
  'Length ( text )', 'Lower ( text )', 'Middle ( text ; start ; numberOfCharacters )',
  'MiddleValues ( text ; startingValue ; numberOfValues )',
  'MiddleWords ( text ; startingWord ; numberOfWords )',
  'PatternCount ( text ; searchString )', 'Position ( text ; searchString ; start ; occurrence )',
  'Proper ( text )', 'Quote ( text )', 'Right ( text ; numberOfCharacters )',
  'RightValues ( text ; numberOfValues )', 'RightWords ( text ; numberOfWords )',
  'SerialIncrement ( text ; incrementBy )', 'SortValues ( values ; sortType ; locale )',
  'Substitute ( text ; searchString ; replaceString )', 'Trim ( text )', 'TrimAll ( text ; trimSpaces ; trimType )',
  'UniqueValues ( values ; caseSensitive ; locale )', 'Upper ( text )', 'ValueCount ( text )',
  'WordCount ( text )',
  // Numbers
  'Abs ( number )', 'Ceiling ( number )', 'Combination ( setSize ; numberOfChoices )',
  'Div ( number ; divisor )', 'Exp ( number )', 'Factorial ( number ; numberOfFactors )',
  'Floor ( number )', 'Int ( number )', 'Lg ( number )', 'Ln ( number )', 'Log ( number )',
  'Mod ( number ; divisor )', 'Random', 'Round ( number ; precision )', 'SetPrecision ( expression ; precision )',
  'Sign ( number )', 'Sqrt ( number )', 'Truncate ( number ; precision )',
  // Date / Time
  'Date ( month ; day ; year )', 'Day ( date )', 'DayName ( date )', 'DayOfWeek ( date )',
  'DayOfYear ( date )', 'Hour ( time )', 'Minute ( time )', 'Month ( date )', 'MonthName ( date )',
  'Seconds ( time )', 'Time ( hours ; minutes ; seconds )', 'Timestamp ( date ; time )',
  'WeekOfYear ( date )', 'Year ( date )',
  // Conversion
  'GetAsBoolean ( data )', 'GetAsDate ( text )', 'GetAsNumber ( text )', 'GetAsText ( data )',
  'GetAsTime ( text )', 'GetAsTimestamp ( text )', 'GetAsURLEncoded ( text )',
  // Logical
  'Case ( test1 ; result1 ; defaultResult )', 'Choose ( test ; result0 ; result1 )',
  'Evaluate ( expression ; fields )', 'EvaluationError ( expression )',
  'ExecuteSQL ( sqlQuery ; fieldSeparator ; rowSeparator ; arguments )',
  'GetField ( fieldName )', 'GetFieldName ( field )', 'GetNthRecord ( fieldName ; recordNumber )',
  'If ( test ; resultOne ; resultTwo )', 'IsEmpty ( field )', 'IsValid ( field )',
  'IsValidExpression ( expression )', 'Let ( [ var1 = value1 ] ; calculation )',
  'Lookup ( sourceField ; failExpression )', 'LookupNext ( sourceField ; lower/higherFlag )',
  'Self', 'SetRecursion ( expression ; maxIterations )', 'True', 'False',
  'While ( [ initialVariable ] ; condition ; [ logic ] ; result )',
  // Aggregate / summary
  'Average ( field )', 'Count ( field )', 'List ( field )', 'Max ( field )', 'Min ( field )',
  'StDev ( field )', 'Sum ( field )', 'GetSummary ( summaryField ; breakField )', 'Extend ( nonRepeatingField )',
  // JSON
  'JSONDeleteElement ( json ; keyOrIndexOrPath )', 'JSONFormatElements ( json )',
  'JSONGetElement ( json ; keyOrIndexOrPath )', 'JSONGetElementType ( json ; keyOrIndexOrPath )',
  'JSONListKeys ( json ; keyOrIndexOrPath )', 'JSONListValues ( json ; keyOrIndexOrPath )',
  'JSONSetElement ( json ; keyOrIndexOrPath ; value ; type )',
  // Encoding / crypto
  'Base64Decode ( text ; fileNameWithExtension )', 'Base64Encode ( data )', 'Base64EncodeRFC ( rfcNumber ; data )',
  'CryptAuthCode ( data ; algorithm ; key )', 'CryptDigest ( data ; algorithm )',
  'HexDecode ( text ; fileNameWithExtension )', 'HexEncode ( data )',
  'TextDecode ( container ; encoding )', 'TextEncode ( text ; encoding ; lineEndings )',
  // Text formatting
  'TextColor ( text ; RGB ( red ; green ; blue ) )', 'TextFont ( text ; fontName )',
  'TextSize ( text ; fontSize )', 'TextStyleAdd ( text ; styles )', 'TextStyleRemove ( text ; styles )',
  'RGB ( red ; green ; blue )',
  // Container
  'GetContainerAttribute ( sourceField ; attributeName )', 'GetHeight ( sourceField )',
  'GetThumbnail ( sourceField ; fitToWidth ; fitToHeight )', 'GetWidth ( sourceField )',
  // Design
  'DatabaseNames', 'FieldNames ( fileName ; layoutName )', 'FieldType ( fileName ; fieldName )',
  'GetNextSerialValue ( fileName ; fieldName )', 'LayoutNames ( fileName )', 'ScriptNames ( fileName )',
  'TableNames ( fileName )', 'ValueListItems ( fileName ; valueListName )', 'ValueListNames ( fileName )',
  'WindowNames ( fileName )',
  // Mobile / location (occasionally useful)
  'GetAVPlayerAttribute ( attributeName )', 'Location ( accuracy ; timeout )',
];

// Get ( flag ) variants — completed as whole expressions.
const GET_FLAGS = [
  'AccountName', 'ActiveFieldContents', 'ActiveFieldName', 'ActiveFieldTableName',
  'ActiveLayoutObjectName', 'ActiveModifierKeys', 'ActiveSelectionSize', 'ActiveSelectionStart',
  'AllowAbortState', 'ApplicationLanguage', 'ApplicationVersion', 'CalculationRepetitionNumber',
  'CurrentDate', 'CurrentHostTimestamp', 'CurrentTime', 'CurrentTimestamp',
  'CurrentTimeUTCMilliseconds', 'CustomMenuSetName', 'DesktopPath', 'Device', 'DocumentsPath',
  'ErrorCaptureState', 'FileMakerPath', 'FileName', 'FilePath', 'FileSize', 'FoundCount',
  'HighContrastState', 'HostApplicationVersion', 'HostIPAddress', 'HostName',
  'InstalledFMPlugins', 'LastError', 'LastExternalErrorDetail', 'LastMessageChoice',
  'LastODBCError', 'LayoutAccess', 'LayoutCount', 'LayoutName', 'LayoutNumber',
  'LayoutTableName', 'LayoutViewState', 'ModifiedFields', 'MultiUserState', 'NetworkProtocol',
  'PageNumber', 'PersistentID', 'PrinterName', 'RecordAccess', 'RecordID',
  'RecordModificationCount', 'RecordNumber', 'RecordOpenCount', 'RecordOpenState',
  'RequestCount', 'RequestOmitState', 'ScreenDepth', 'ScreenHeight', 'ScreenWidth',
  'ScriptName', 'ScriptParameter', 'ScriptResult', 'SortState', 'StatusAreaState',
  'SystemDrive', 'SystemIPAddress', 'SystemLanguage', 'SystemNICAddress', 'SystemPlatform',
  'SystemVersion', 'TemporaryPath', 'TextRulerVisible', 'TotalRecordCount', 'TriggerCurrentState',
  'TriggerKeystroke', 'TriggerModifierKeys', 'TriggerTargetState', 'UserCount', 'UserName',
  'UUID', 'UUIDNumber', 'WindowContentHeight', 'WindowContentWidth', 'WindowDesktopHeight',
  'WindowDesktopWidth', 'WindowHeight', 'WindowLeft', 'WindowMode', 'WindowName',
  'WindowStyle', 'WindowTop', 'WindowVisible', 'WindowWidth', 'WindowZoomLevel',
];

// Script step names beyond the converter's built-ins, offered in completion so
// typing any real step name is easy. Steps without a built-in or learned
// template still need to be copied from FileMaker once before Ctrl+Alt+B works.
const EXTRA_STEP_NAMES = [
  'Adjust Window', 'Allow Formatting Bar', 'Allow User Abort', 'Arrange All Windows', 'Beep',
  'Change Password', 'Check Found Set', 'Check Record', 'Check Selection', 'Clear',
  'Close Data File', 'Close File', 'Close Popover', 'Close Window', 'Commit Records/Requests',
  'Configure Local Notification', 'Constrain Found Set', 'Copy', 'Copy All Records/Requests',
  'Copy Record/Request', 'Correct Word', 'Create Data File', 'Cut', 'Delete Account',
  'Delete All Records', 'Delete Data File', 'Delete Portal Row', 'Delete Record/Request',
  'Dial Phone', 'Edit User Dictionary', 'Enable Account', 'End Transaction', 'Enter Browse Mode',
  'Enter Preview Mode', 'Execute FileMaker Data API', 'Execute SQL', 'Exit Application',
  'Export Field Contents', 'Export Records', 'Extend Found Set', 'Find Matching Records',
  'Flush Cache to Disk', 'Get Directory', 'Get File Exists', 'Get File Size', 'Get Folder Path',
  'Go to Field', 'Go to Layout', 'Go to Next Field', 'Go to Object', 'Go to Portal Row',
  'Go to Previous Field', 'Go to Related Record', 'Import Records', 'Insert Audio/Video',
  'Insert Calculated Result', 'Insert Current Date', 'Insert Current Time', 'Insert Current User Name',
  'Insert File', 'Insert from Device', 'Insert from Index', 'Insert from Last Visited',
  'Insert from URL', 'Insert PDF', 'Insert Picture', 'Insert Text', 'Install Menu Set',
  'Install OnTimer Script', 'Install Plug-In File', 'Loop', 'Modify Last Find', 'Move/Resize Window',
  'New File', 'New Window', 'Open Data File', 'Open Favorites', 'Open File', 'Open Help',
  'Open Hosts', 'Open Manage Containers', 'Open Manage Data Sources', 'Open Manage Database',
  'Open Manage Layouts', 'Open Manage Scripts', 'Open Manage Themes', 'Open Manage Value Lists',
  'Open My Apps', 'Open Preferences', 'Open Script Workspace', 'Open Settings', 'Open URL',
  'Paste', 'Perform AppleScript', 'Perform Find/Replace', 'Perform JavaScript in Web Viewer',
  'Perform Quick Find', 'Perform Script on Server', 'Print', 'Print Setup', 'Read from Data File',
  'Recover File', 'Redo', 'Refresh Object', 'Refresh Portal', 'Refresh Window',
  'Re-Login', 'Relookup Field Contents', 'Replace Field Contents', 'Reset Account Password',
  'Resume Script', 'Revert Record/Request', 'Revert Transaction', 'Save a Copy as',
  'Save Records as Excel', 'Save Records as PDF', 'Save Records as Snapshot Link',
  'Select All', 'Select Dictionaries', 'Select Window', 'Send DDE Execute', 'Send Event',
  'Send Mail', 'Set Allowed Orientations', 'Set Field by Name', 'Set Layout Object Animation',
  'Set Multi-User', 'Set Next Serial Value', 'Set Selection', 'Set Session Identifier',
  'Set Use System Formats', 'Set Web Viewer', 'Set Window Title', 'Set Zoom Level',
  'Show/Hide Menubar', 'Show/Hide Text Ruler', 'Show/Hide Toolbars', 'Show Omitted Only',
  'Sort Records', 'Sort Records by Field', 'Speak', 'Spelling Options', 'Truncate Table',
  'Undo/Redo', 'Unsort Records', 'Upload to Host', 'View As', 'Write to Data File',
];

module.exports = { FUNCTIONS, GET_FLAGS, EXTRA_STEP_NAMES };
